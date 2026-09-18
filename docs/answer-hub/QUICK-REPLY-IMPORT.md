# Quick Reply file import

The admin Quick replies page now provides **Import file** for CSV and XLSX files. XLSX imports read the `Import_Data` worksheet and ignore other worksheets. Preview parses, validates, normalizes category values, and compares shortcuts through `inbox.qr_list` without writing data.

Import requires an authenticated `admin` session. Apply uses the existing `inbox.qr_upsert` RPC for new and changed rows; identical rows are skipped and invalid previews cannot be applied. Active flags, multiline Thai text, and URLs are preserved. The source and image URL columns are accepted for template compatibility; the legacy Quick Reply schema does not expose storage fields for them, so they are not written to a second table.

The Asher Naii workbook has 32 valid rows. `NAII_PRICE`, `NAII_PSM`, and `NAII_ROOM_PRICE` parse as inactive and are never enabled by the importer.
