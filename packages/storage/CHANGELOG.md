# @adminigloo/storage

## 0.1.0

### Minor Changes

- Files with receipts. `@adminigloo/storage` first release: tenant-scoped file
  storage with the rows in the app's own database and the bytes behind a
  two-method adapter — `storeFile` writes the blob first and the receipt
  second (and takes the blob back out when the receipt fails), reads and
  deletes are tenant-scoped in the where clause so a guessed id settles
  nothing, and no vendor SDK is imported anywhere: Vercel Blob, S3 or a
  directory on disk are one-liner adapters the consuming app owns. Filenames
  are sanitized by character code, sizes are capped before the store is
  touched, and `deleteFile` reports a store failure instead of throwing,
  because once the row is gone the product has already kept its promise.
