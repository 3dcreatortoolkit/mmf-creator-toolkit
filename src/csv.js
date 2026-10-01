export const HEADERS = [
  'listing_type', 'name', 'url', 'price_amount',
  'price_currency', 'is_free', 'description_text', 'tags_json', 'categories_json',
  'collections_json', 'image_urls_json', 'files_json', 'published_at', 'views', 'likes', 'exported_at',
];

// Excel and other spreadsheets can evaluate cells starting with these characters.
function cell(value) {
  let text = value == null ? '' : String(value);
  if (/^[\s\uFEFF]*[=+@\-\t\r]/.test(text) && typeof value === 'string') text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function createCsv(rows, { includeFiles = false } = {}) {
  const headers = includeFiles ? HEADERS : HEADERS.filter(key => key !== 'files_json');
  return '\uFEFF' + [headers, ...rows.map(row => headers.map(key => row[key] ?? ''))]
    .map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
