/**
 * 01_SheetIO.gs — Generic read/write/upsert helpers.
 * Every other module talks to sheets via these functions. Don't call getRange directly elsewhere.
 */

/** Returns all rows as objects keyed by header row. */
function readAllRows(sheetName) {
  const sh = ss().getSheetByName(sheetName);
  if (!sh) throw new Error('Sheet not found: ' + sheetName);
  const range = sh.getDataRange();
  const values = range.getValues();
  if (values.length < 2) return [];
  const headers = values[0];
  return values.slice(1).map((row, idx) => {
    const obj = { _rowNum: idx + 2 };
    headers.forEach((h, i) => { obj[h] = row[i]; });
    return obj;
  });
}

/** Returns the first row matching keyField === keyValue, or null. */
function findRow(sheetName, keyField, keyValue) {
  const rows = readAllRows(sheetName);
  return rows.find(r => r[keyField] === keyValue) || null;
}

/** Returns all rows matching keyField === keyValue. */
function findRows(sheetName, keyField, keyValue) {
  const rows = readAllRows(sheetName);
  return rows.filter(r => r[keyField] === keyValue);
}

/** Appends a new row built from an object. Object keys must match headers.
 * Uses header count from row 1 only — not getLastColumn() which can be
 * inflated by stale data outside the header range. */
function appendRow(sheetName, rowObj) {
  const sh = ss().getSheetByName(sheetName);
  // Read only as far as the last non-empty header cell in row 1
  const allHeaders = sh.getRange(1, 1, 1, sh.getMaxColumns()).getValues()[0];
  const headerCount = allHeaders.reduce((last, h, i) => h !== '' ? i + 1 : last, 0);
  const headers = allHeaders.slice(0, headerCount);
  const arr = headers.map(h => rowObj.hasOwnProperty(h) ? rowObj[h] : '');
  sh.appendRow(arr);
}

/** Updates a row in place by _rowNum (sheet row index). */
function updateRow(sheetName, rowNum, updates) {
  const sh = ss().getSheetByName(sheetName);
  const allHeaders = sh.getRange(1, 1, 1, sh.getMaxColumns()).getValues()[0];
  const headerCount = allHeaders.reduce((last, h, i) => h !== '' ? i + 1 : last, 0);
  const headers = allHeaders.slice(0, headerCount);
  const range = sh.getRange(rowNum, 1, 1, headerCount);
  const current = range.getValues()[0];
  headers.forEach((h, i) => {
    if (updates.hasOwnProperty(h)) current[i] = updates[h];
  });
  range.setValues([current]);
}

/** Upserts: update if found by keyField, else append. */
function upsertRow(sheetName, keyField, rowObj) {
  const existing = findRow(sheetName, keyField, rowObj[keyField]);
  if (existing) {
    updateRow(sheetName, existing._rowNum, rowObj);
    return { action: 'updated', rowNum: existing._rowNum };
  } else {
    appendRow(sheetName, rowObj);
    return { action: 'inserted', rowNum: -1 };
  }
}

/** Decrements a numeric field on a row found by keyField. Returns new value. Caller must hold a lock. */
function decrementField(sheetName, keyField, keyValue, field, delta) {
  const sh = ss().getSheetByName(sheetName);
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const keyCol = headers.indexOf(keyField);
  const valCol = headers.indexOf(field);
  if (keyCol === -1 || valCol === -1) throw new Error('Field not found: ' + keyField + ' or ' + field);
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return null;
  const colValues = sh.getRange(2, keyCol + 1, lastRow - 1, 1).getValues();
  for (let i = 0; i < colValues.length; i++) {
    if (colValues[i][0] === keyValue) {
      const rowNum = i + 2;
      const cell = sh.getRange(rowNum, valCol + 1);
      const current = Number(cell.getValue());
      const next = current - delta;
      cell.setValue(next);
      return next;
    }
  }
  return null;
}

/** Increments a numeric field by delta (uses decrement with negative delta). */
function incrementField(sheetName, keyField, keyValue, field, delta) {
  return decrementField(sheetName, keyField, keyValue, field, -delta);
}

/** Increments by matching on TWO fields (composite key) — used for daily quotas. */
function incrementCompositeField(sheetName, key1Field, key1Value, key2Field, key2Value, field, delta) {
  const sh = ss().getSheetByName(sheetName);
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const k1Col = headers.indexOf(key1Field);
  const k2Col = headers.indexOf(key2Field);
  const valCol = headers.indexOf(field);
  if (k1Col === -1 || k2Col === -1 || valCol === -1) {
    throw new Error('Field not found in ' + sheetName);
  }
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return null;
  const values = sh.getRange(2, 1, lastRow - 1, headers.length).getValues();
  for (let i = 0; i < values.length; i++) {
    if (values[i][k1Col] === key1Value && values[i][k2Col] === key2Value) {
      const rowNum = i + 2;
      const cell = sh.getRange(rowNum, valCol + 1);
      const current = Number(cell.getValue());
      cell.setValue(current + delta);
      return current + delta;
    }
  }
  return null;
}