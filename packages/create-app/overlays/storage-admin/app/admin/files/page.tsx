import { FilesManager } from "__SCOPE__/storage-widget/admin";
import { PageHeader } from "@/components/ui";
import { FILES_MORE_ROOM } from "@/server/files";

export const dynamic = "force-dynamic";

/**
 * The business's files (Tenancy 2b-1): everything it keeps — photos and
 * files on its visits, estimates and invoices, customers' estimate photos and
 * its own uploads — with what each is attached to, filters by kind of record,
 * "Largest first", and "Using X of Y" against the allowance
 * (FILES_ALLOWANCE_MB).
 *
 * __SCOPE__/storage-widget's <FilesManager>, over /api/admin/files (which
 * checks your staff keys on every call — the admin layout's gate is a
 * convenience, not the boundary). The list shows only the files you may
 * open: a record's files follow that record's own permissions.
 *
 * Full, it says to delete files or ask the person who set up this site for
 * more room (FILES_MORE_ROOM, review BO-5): the site IS the business, so it
 * never tells the business to ask itself; raising FILES_ALLOWANCE_MB is that
 * person's job. `title={false}` (review BO-11): the header above is the
 * heading.
 */
export default function FilesPage() {
  return (
    <>
      <PageHeader title="Files" description="The photos and files this business keeps." />
      <FilesManager baseUrl="/api/admin/files" platformName={FILES_MORE_ROOM.platformName} title={false} />
    </>
  );
}
