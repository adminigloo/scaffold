import { FilesManager } from "__SCOPE__/storage-widget/admin";
import { CompanyGate } from "@/components/CompanyGate";
import { PageHeader } from "@/components/ui";
import { FILES_MORE_ROOM } from "@/server/files";

export const dynamic = "force-dynamic";

/**
 * The company's files (Tenancy 2b-1): everything it keeps — photos and files
 * on its visits, estimates and invoices, customers' estimate photos, its logo
 * and its own uploads — with what each is attached to ("Estimate 1042 · Pat
 * Rivera"), filters by kind of record, "Largest first", and "Using 1.2 GB of
 * 5 GB" against the company's allowance.
 *
 * __SCOPE__/storage-widget's <FilesManager>, talking to THIS company's routes
 * (/api/app/{company id}/files). The list shows only the files the person may
 * open (a record's files follow that record's own permissions); the usage is
 * the company's whole usage. When the company is full it says to delete
 * files or write to the platform for more room (FILES_MORE_ROOM: this site's
 * name and SUPPORT_EMAIL; review BO-6). `title={false}` (review BO-11): the
 * header above is the heading. The logo is changed in __TENANT_LABEL_LOWER__ settings (review
 * FH-11), and the Files screen says so.
 */
export default async function CompanyFilesPage() {
  return (
    <CompanyGate path="/app/files" permission="files.view">
      {({ company }) => (
        <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
          <PageHeader title="Files" description={`The photos and files ${company.name} keeps.`} />
          <FilesManager
            baseUrl={`/api/app/${company.id}/files`}
            platformName={FILES_MORE_ROOM.platformName}
            supportEmail={FILES_MORE_ROOM.supportEmail}
            logoSettings="__TENANT_LABEL_LOWER__ settings"
            title={false}
          />
        </main>
      )}
    </CompanyGate>
  );
}
