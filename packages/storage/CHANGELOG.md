# @adminigloo/storage

## 0.3.0

### Minor Changes

- ed86e90: Delete a company (create-app 0.37): `forgetTenant(db, tenantId)` from the root takes every row this package keeps for one company — its file records, live and removed — with `listTenantObjects` (read on the same transaction first) and `storage.deleteObjects(objects)` to delete the bytes once the deletion has committed (never throws; failures are reported) — children first, each statement filtered by the company's id, on the caller's transaction. Returns the rows each table lost; refuses an empty id and the site's own ("*"). Proved per package on PGlite with `@adminigloo/testing/forget`: every table planted for two companies, the first forgotten, nothing of the second touched.

## 0.2.0

### Minor Changes

- 786a643: Private files per company (Tenancy 2b-1).
  
  - **Private by default.** Each purpose says private or public. Private photos
    and files go to a store that never hands out an address, and are served
    only through the company's signed-in route (always streamed by the package,
    never a redirect) or a short-lived signed link. Only the logo is public, under
    a key with 192 random bits and no company in it.
  - **Purposes** (`attachment`, `library`, `company.logo`, and any a package
    adds, such as the estimator's photos): the types each takes, read from the
    bytes (SVG and HTML never), a size limit, whether a full company may still
    keep it, and a share of the allowance it may never pass (customers' estimate
    photos stop at a fifth, so strangers can't fill the room the crew's photos
    need). A share is for uploads from the public: a file a signed-in person
    adds (`addedBy`) is an ordinary file, never stopped by the share nor
    counted in it, and refused like any file when the company is full. The
    stored name takes the real type's extension (`report.html` holding a PDF
    is kept as `report.pdf`). The logo shows on the Files screen with
    `files.view` alone.
  - **Records decide.** A file on a visit, an estimate or an invoice is that
    record's: its own permissions say who sees, adds and removes it, and
    `files.view` alone opens no record's files. Crew see and add files on their
    own visits only, and may take back their own photo within a day.
    `files.manage` sees and removes anything, an orphaned file included.
  - **The allowance and the usage.** `allowanceBytes(tenantId)` is checked
    before the bytes are stored and again under a per-company lock before the
    row is written, so two uploads can't both take the last of the room.
    `onUsage` hears every store, every refusal and every share used up
    (`share_full`), and `storageAlertKinds` / `storageUsageAlert` turn them
    into "almost full" (once a month), "full" (once a day) and "customers'
    photos couldn't be added" (once a day) alerts, saying who to ask for more
    room and, with `supportEmail`, where to write.
  - **Signed links checked on every open:** at most an hour, naming the company,
    the file and the person who made it; `signing.stillValid` must say the
    company is active and the person still a member, and is handed the file and
    `mayView`, which runs the file's own rule again for its maker, so a removed
    member's links, a demoted member's, and every link of a suspended company
    stop on the next open.
  - **Keys never carry a company id** (`t/{hash}/{year}/{month}/{random}`), and
    every adapter refuses a key it didn't expect before touching anything. A
    0.1 file name with a `%` in it still opens and deletes; only an encoded
    `.`, `/`, `\` or `%` is refused.
  - **Deleting removes the bytes** from the store they are in; a store that
    fails leaves the file marked, and `purgeDeleted` (the files cron) tries
    again, reporting the key after ten tries.
  - **`moveToPrivate`** moves 0.1's (and 2a's) public files into the private
    store, keeping their ids. `checkPrivateStore` says when a "private" store
    lets anyone read it (on R2, at the bucket's r2.dev address too, given as
    `publicUrlToCheck`; without it, a `note` says what couldn't be checked).
  - **`logoStore()`** (tenancy's logo store) and **`purposeStore()`** (the
    estimator's photo store), each in its package's own shape.
  - **Handlers, route tables, permissions (`files.view`, `files.manage`) and the
    wire** for `@adminigloo/storage-widget`. Uploads are counted as they arrive
    and stopped at 4 MB, with or without a `Content-Length`, and must be one
    file. Every upload, link and remove must come from the app's own origin
    (a sibling subdomain is refused like another site).
  - **Adapters:** `./vercel-blob` (the host passes the SDK's own namespace,
    which type-checks against @vercel/blob 2.x; a "private" store whose token
    turns out public is refused), `./s3` (R2, MinIO, AWS S3, signed by hand, no
    SDK), `./local` (development only), and `./testing` (an in-memory store and
    `checkHostSeams`, the install check a host shows the business owner: the
    company in every lookup, a member without files permissions refused, links
    re-checked against their maker, a suspended company, an id written another
    way).
  - **Table names are yours:** a prefix or a Postgres schema
    (`defineStorageTables`); `createStorage` requires `tables`, so it can never
    point at a host's own `stored_files`, and every statement that changes rows
    names a column only this package's table has. Shipped SQL (`storageSql`,
    `sql/storage-0.2.0.sql`) and the 0.1 upgrade (`sql/upgrade-0.1-to-0.2.sql`),
    exported as `./sql/*`, each ONE statement opening with a guard that refuses
    to run over a table that isn't ours, so not even `psql -f` can run part of
    it.
  - **No `@adminigloo/db`:** the package mints its own ids, so importing the
    schema never loads the Neon driver.
  
  `BlobStore` is a new shape (put, get, delete, and an optional private check).
  0.1's two-method adapter is now `BlobStoreV1`, which 0.1's functions
  (`storeFile`, `listFiles`, `getFile`, `deleteFile`) still take; they are kept
  on the default table, deprecated. Every 0.1 file, and every photo the 2a
  estimator kept, stays public at its old address until `moveToPrivate` moves
  it.

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
