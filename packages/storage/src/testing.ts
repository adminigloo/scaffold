/**
 * `@adminigloo/storage/testing`: what a test (the package's, the emitted
 * proof's, a host's) needs: an in-memory store that checks keys like every
 * real adapter, and `checkHostSeams` (6.14, review G19), the list a host's
 * developer runs against the host's own seams and shows the business owner.
 */
export { createMemoryBlobStore } from "./memory.js";
export type { MemoryBlobStore } from "./memory.js";
export { checkHostSeams, NOT_A_MEMBER_ID, ONE_PIXEL_PNG } from "./host-seams.js";
export type { CheckStorageHostSeamsInput, HostSeamsCheckResult, HostSeamsRequest } from "./host-seams.js";
