import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { TenancyTransport } from "./client.js";
import { brandColorReport, normaliseHexColor, type BrandColorReport } from "./color.js";
import type { ClientError } from "./http.js";
import {
  CheckCircleIcon,
  describedBy,
  Field,
  LiveRegion,
  Loading,
  Notice,
  useMounted,
  WidgetRoot,
  type ChromeProps,
  type NounProps,
} from "./parts.js";
import { isUnconnected, useAnnouncer, useDebounced, useLoaded, useTenancyTransport } from "./transport.js";
import { otherTimeZoneChoices, US_TIME_ZONES, zoneOptionLabel } from "./timezones.js";
import type {
  BrandColorReportWire,
  CompanyProfileWire,
  CompanyWire,
  SettingsFieldWire,
  SettingsSectionWire,
  SettingsWire,
  SlugCheckWire,
} from "./types.js";
import { errorText, nounOf, NOT_CONNECTED_MESSAGE, ONBOARDING, SETTINGS, W, type Noun } from "./words.js";

/**
 * <CompanySettings> (contract 8.7): the company's name and web address, its
 * logo and brand colour, and every settings section the project registered
 * (tenancy's "Business details", and in Tenancy 2 the fragments other
 * packages add). Three kinds of area, each a <section> with its own heading,
 * Save and status line, each saved on its own: an owner fixing a typo in the
 * phone number never re-sends the logo.
 *
 * THE REGISTRY RENDERS ITSELF. Sections arrive with their field specs
 * (label, kind, width, autocomplete); the widget draws them generically, so a
 * package adding a fragment ships no UI of its own and a project needs no
 * widget release to show it.
 *
 * DEEP LINKS. The setup checklist links to `#details` and `#branding`; the
 * page scrolls to that section and moves focus to its heading, so the owner
 * lands where the checklist promised.
 */

export interface CompanySettingsProps extends ChromeProps, NounProps {
  baseUrl?: string;
  transport?: TenancyTransport;
  tenantId: string;
  initialCompany?: CompanyProfileWire;
  initialSettings?: SettingsWire;
  /** Shown before the address. Default "/t/". */
  publicUrlPrefix?: string;
}

const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp"];
const LOGO_MAX_BYTES = 1024 * 1024;
/** The longest side a logo is scaled down to before upload. Shown at 24–96 px; 512 is plenty for a sharp screen. */
const LOGO_MAX_SIDE = 512;

/**
 * Shrink a picture in the browser before it's sent (review T1-11).
 *
 * WHY. A lawn-care owner photographs the logo on the truck: a 2–5 MB JPEG (or
 * an iPhone HEIC). Refusing it with "make it under 1 MB" needs someone who
 * knows how to resize an image. So any picture the browser can decode is
 * drawn onto a canvas at most LOGO_MAX_SIDE px on its longest side and saved
 * as WebP (JPEG where WebP isn't supported) at 0.85 quality. The server still
 * checks the bytes, type and size.
 *
 * Returns null when the browser can't do it (no canvas, an undecodable file),
 * and the caller falls back to sending the original if it already fits.
 */
export async function shrinkLogo(file: Blob): Promise<Blob | null> {
  try {
    if (typeof createImageBitmap !== "function" || typeof document === "undefined") return null;
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, LOGO_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();
    const encode = (type: string) =>
      new Promise<Blob | null>((resolve) => canvas.toBlob((blob) => resolve(blob), type, 0.85));
    const webp = await encode("image/webp");
    const out = webp && webp.type === "image/webp" ? webp : await encode("image/jpeg");
    return out && out.size > 0 && out.size <= LOGO_MAX_BYTES ? out : null;
  } catch {
    return null;
  }
}

/** The browser's own time zone, for suggesting one when none is saved (review T1-15). */
function deviceTimeZone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === "string" && zone.includes("/") ? zone : null;
  } catch {
    return null;
  }
}

/** The id a section's <section> carries: the company fragment answers to #details (the checklist's link). */
export function sectionAnchor(key: string): string {
  return key === "company" ? "details" : key;
}

/** "4.5", "21", "4.48": a ratio as people write it. */
export function formatRatio(ratio: number): string {
  return ratio.toFixed(2).replace(/\.?0+$/, "");
}

type Announcer = ReturnType<typeof useAnnouncer>;

export function CompanySettings(props: CompanySettingsProps) {
  const { tenantId, publicUrlPrefix = "/t/", theme, nonce, className, style } = props;
  const noun = nounOf(props.noun);
  const transport = useTenancyTransport(props.transport, props.baseUrl);
  const unconnected = isUnconnected(props.transport, props.baseUrl);
  const profile = useLoaded(() => transport.company(tenantId), props.initialCompany, unconnected ? null : tenantId);
  const settings = useLoaded(() => transport.settings(tenantId), props.initialSettings, unconnected ? null : tenantId);
  const announcer = useAnnouncer();
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const rootRef = useRef<HTMLDivElement | null>(null);
  const linked = useRef(false);
  const chrome = { theme, nonce, className, style };

  const anyDirty = Object.values(dirty).some(Boolean);
  useEffect(() => {
    if (!anyDirty || typeof window === "undefined") return;
    // Only while something is unsaved: a guard that is always on makes every
    // navigation ask "leave site?", and people learn to click through it.
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
      return "";
    };
    // A link INSIDE the app (the header's Team, a Next.js <Link>) changes the
    // page without unloading it, so "beforeunload" never fires there (review
    // R2 T1BO-08: an owner tapped Team with an unsaved name and lost it). A
    // capturing click listener asks first; "Stay" stops the navigation before
    // the router sees the click.
    const links = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      const href = anchor.getAttribute("href") ?? "";
      if (href.startsWith("#")) return;
      if (typeof window.confirm === "function" && !window.confirm(SETTINGS.leaveUnsaved)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", guard);
    document.addEventListener("click", links, true);
    return () => {
      window.removeEventListener("beforeunload", guard);
      document.removeEventListener("click", links, true);
    };
  }, [anyDirty]);

  const ready = profile.data !== null && settings.data !== null;
  useEffect(() => {
    if (!ready || linked.current || typeof window === "undefined") return;
    linked.current = true;
    const hash = decodeURIComponent(window.location.hash.replace(/^#/, ""));
    if (!hash) return;
    const section = [...(rootRef.current?.querySelectorAll<HTMLElement>("section[id]") ?? [])].find((el) => el.id === hash);
    const heading = section?.querySelector<HTMLElement>("h2");
    if (!section || !heading) return;
    if (typeof section.scrollIntoView === "function") section.scrollIntoView({ block: "start" });
    heading.focus();
  }, [ready]);

  const markDirty = (area: string, value: boolean) =>
    setDirty((all) => (Boolean(all[area]) === value ? all : { ...all, [area]: value }));

  if (unconnected) {
    return (
      <WidgetRoot {...chrome}>
        <div className="aitw-panel">
          <Notice tone="error">{NOT_CONNECTED_MESSAGE}</Notice>
        </div>
      </WidgetRoot>
    );
  }
  const company = profile.data;
  if (!company) {
    return (
      <WidgetRoot {...chrome}>
        <div className="aitw-panel">
          {profile.loading ? <Loading label={W.loading} /> : <Notice tone="error">{errorText(profile.error ?? { code: "bad_response", message: "" }, noun)}</Notice>}
        </div>
      </WidgetRoot>
    );
  }
  const canEdit = company.can.includes("tenant.edit");
  const setCompany = (next: CompanyWire) => profile.set({ ...company, company: next });
  // In page order: the area's own heading, and the section to scroll to.
  const areas: { key: string; label: string; anchor: string }[] = [
    { key: "profile", label: SETTINGS.profileHeading, anchor: "profile" },
    { key: "branding", label: SETTINGS.brandingHeading, anchor: "branding" },
    ...(settings.data?.sections ?? []).map((s) => ({ key: `section:${s.key}`, label: s.label, anchor: sectionAnchor(s.key) })),
  ];
  const unsaved = areas.filter((a) => dirty[a.key]);
  const unsavedLabels = unsaved.map((a) => a.label);
  const firstUnsaved = unsaved[0]?.anchor ?? null;

  return (
    <WidgetRoot {...chrome} data={{ "aitw-settings": company.company.id }}>
      <div className="aitw-page" ref={rootRef}>
        <ProfileSection
          company={company.company}
          canEdit={canEdit}
          publicUrlPrefix={publicUrlPrefix}
          transport={transport}
          tenantId={tenantId}
          noun={noun}
          announcer={announcer}
          onSaved={setCompany}
          onDirty={(value) => markDirty("profile", value)}
        />
        <BrandingSection
          company={company.company}
          canEdit={canEdit}
          logoUploads={company.logoUploads}
          transport={transport}
          tenantId={tenantId}
          noun={noun}
          announcer={announcer}
          onSaved={setCompany}
          onDirty={(value) => markDirty("branding", value)}
        />
        {settings.data ? (
          settings.data.sections.map((section) => (
            <RegistrySection
              key={section.key}
              section={section}
              transport={transport}
              tenantId={tenantId}
              noun={noun}
              announcer={announcer}
              onSaved={(next) =>
                settings.set({ sections: (settings.data?.sections ?? []).map((s) => (s.key === next.key ? next : s)) })
              }
              onDirty={(value) => markDirty(`section:${section.key}`, value)}
            />
          ))
        ) : settings.loading ? (
          <div className="aitw-panel">
            <Loading label={W.loading} />
          </div>
        ) : settings.error ? (
          <div className="aitw-panel">
            <Notice tone="error">{errorText(settings.error, noun)}</Notice>
          </div>
        ) : null}
        {anyDirty ? (
          // What isn't saved, in a bar that stays in view (review R2 T1BO-08):
          // each part saves on its own, and on a phone the "Unsaved changes"
          // beside the top Save is a long scroll away from the bottom one.
          <div className="aitw-unsaved-bar" role="status" data-aitw-unsaved="">
            <span>{SETTINGS.unsavedBar(unsavedLabels)}</span>
            {firstUnsaved ? (
              <a className="aitw-btn aitw-btn-secondary aitw-btn-sm" href={`#${firstUnsaved}`} onClick={(event) => {
                const target = rootRef.current?.querySelector<HTMLElement>(`section[id="${firstUnsaved}"]`);
                if (!target) return;
                event.preventDefault();
                if (typeof target.scrollIntoView === "function") target.scrollIntoView({ block: "start" });
                target.querySelector<HTMLElement>("h2")?.focus();
              }}>
                {SETTINGS.goToUnsaved}
              </a>
            ) : null}
          </div>
        ) : null}
        <LiveRegion status={announcer.status} alert={announcer.alert} srOnly />
      </div>
    </WidgetRoot>
  );
}

// ---------------------------------------------------------------------------
// A section's frame: heading, body, Save, status line
// ---------------------------------------------------------------------------

function SectionFrame({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  const headingId = `${id}-heading`;
  return (
    <section className="aitw-panel" id={id} aria-labelledby={headingId} data-aitw-section={id}>
      <div className="aitw-head">
        <h2 className="aitw-title" id={headingId} tabIndex={-1}>
          {title}
        </h2>
        {description ? <p className="aitw-sub">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

function SaveRow({ saving, dirty, saved, error, disabled }: { saving: boolean; dirty: boolean; saved: boolean; error: string | null; disabled?: boolean }) {
  return (
    <div className="aitw-actions">
      <button type="submit" className="aitw-btn aitw-btn-primary" disabled={saving || disabled} aria-busy={saving || undefined}>
        {saving ? W.saving : W.save}
      </button>
      {error ? (
        <span className="aitw-danger-text" data-aitw-line="error">
          {error}
        </span>
      ) : dirty ? (
        <span className="aitw-dirty" data-aitw-line="dirty">
          {W.unsaved}
        </span>
      ) : saved ? (
        <span className="aitw-ok-text" data-aitw-line="saved">
          {W.saved}
        </span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 1. Name and web address
// ---------------------------------------------------------------------------

function ProfileSection({
  company,
  canEdit,
  publicUrlPrefix,
  transport,
  tenantId,
  noun,
  announcer,
  onSaved,
  onDirty,
}: {
  company: CompanyWire;
  canEdit: boolean;
  publicUrlPrefix: string;
  transport: TenancyTransport;
  tenantId: string;
  noun: Noun;
  announcer: Announcer;
  onSaved: (company: CompanyWire) => void;
  onDirty: (dirty: boolean) => void;
}) {
  const nameId = useId();
  const slugId = useId();
  const [name, setName] = useState(company.name);
  const [slug, setSlug] = useState(company.slug);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [slugError, setSlugError] = useState<{ message: string; suggestion: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [check, setCheck] = useState<{ slug: string; data: SlugCheckWire | null } | null>(null);
  const personal = company.kind === "personal";
  const slugEditable = canEdit && !personal;

  const nextSlug = slug.trim().toLowerCase();
  const dirty = name !== company.name || (slugEditable && nextSlug !== company.slug);
  useEffect(() => onDirty(dirty), [dirty, onDirty]);

  const settled = useDebounced(slugEditable && nextSlug && nextSlug !== company.slug ? nextSlug : "", 350);
  useEffect(() => {
    if (!settled) return;
    let alive = true;
    void transport.checkSlug({ slug: settled, tenantId }).then((res) => {
      if (alive) setCheck({ slug: settled, data: res.ok ? res.data : null });
    });
    return () => {
      alive = false;
    };
  }, [settled, transport, tenantId]);
  const current = check && check.slug === nextSlug && nextSlug !== company.slug ? check.data : null;
  const problem = current && !current.available ? current : null;
  const slugMessage = slugError?.message ?? problem?.message ?? null;
  const suggestion = slugError ? slugError.suggestion : problem?.suggestion || null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving || !canEdit) return;
    setError(null);
    setNameError(null);
    setSlugError(null);
    const body: { name?: string; slug?: string } = {};
    if (name !== company.name) body.name = name;
    if (slugEditable && nextSlug !== company.slug) body.slug = nextSlug;
    if (!body.name && !body.slug) {
      setSaved(true);
      return;
    }
    setSaving(true);
    const res = await transport.updateProfile(tenantId, body);
    setSaving(false);
    if (res.ok) {
      onSaved(res.data.company);
      setName(res.data.company.name);
      setSlug(res.data.company.slug);
      setSaved(true);
      announcer.announce(`${SETTINGS.profileHeading}: ${W.saved}.`);
      return;
    }
    setSaved(false);
    const e = res.error;
    if (e.code === "name_invalid") setNameError(errorText(e, noun));
    else if (e.code === "slug_invalid" || e.code === "slug_reserved" || e.code === "slug_taken")
      setSlugError({ message: errorText(e, noun), suggestion: e.suggestion ?? null });
    else if (e.code === "invalid" && e.issues?.some((i) => i.path[0] === "name" || i.path[0] === "slug")) {
      for (const issue of e.issues) {
        if (issue.path[0] === "name") setNameError(issue.message);
        if (issue.path[0] === "slug") setSlugError({ message: issue.message, suggestion: null });
      }
    } else setError(errorText(e, noun));
    announcer.fail(errorText(e, noun));
  };

  return (
    <SectionFrame id="profile" title={SETTINGS.profileHeading} description={canEdit ? undefined : SETTINGS.readOnly}>
      <form className="aitw-form" onSubmit={(event) => void submit(event)} noValidate>
        <Field id={nameId} label={SETTINGS.nameLabel(noun)} error={nameError}>
          <input
            id={nameId}
            className="aitw-input"
            type="text"
            autoComplete="organization"
            maxLength={80}
            readOnly={!canEdit}
            value={name}
            aria-invalid={nameError ? true : undefined}
            aria-describedby={describedBy(nameId, false, nameError)}
            onChange={(event) => {
              setName(event.target.value);
              setSaved(false);
              setNameError(null);
            }}
          />
        </Field>
        <Field
          id={slugId}
          label={SETTINGS.addressLabel}
          hint={personal ? SETTINGS.personalAddress : slugEditable ? SETTINGS.addressWarning : undefined}
          error={slugMessage}
        >
          <div className="aitw-slug-row">
            <span className="aitw-slug-prefix" aria-hidden="true" title={publicUrlPrefix}>
              {publicUrlPrefix}
            </span>
            <input
              id={slugId}
              className="aitw-input"
              type="text"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              maxLength={60}
              readOnly={!slugEditable}
              value={slug}
              aria-invalid={slugMessage ? true : undefined}
              aria-describedby={describedBy(slugId, personal || slugEditable, slugMessage)}
              onChange={(event) => {
                setSlug(event.target.value.toLowerCase());
                setSaved(false);
                setSlugError(null);
              }}
            />
          </div>
          {/* The full address as text: the prefix box above is cut on a phone
              ("https://igloo-back-of…") and the whole address was never
              visible (review T1-15). */}
          <span className="aitw-hint" data-aitw-full-address="">
            {publicUrlPrefix}
            {nextSlug || company.slug}
          </span>
        </Field>
        {suggestion ? (
          <div className="aitw-availability">
            <button
              type="button"
              className="aitw-btn aitw-btn-secondary aitw-btn-sm"
              onClick={() => {
                setSlug(suggestion);
                setSlugError(null);
              }}
            >
              {ONBOARDING.use(suggestion)}
            </button>
          </div>
        ) : current?.available ? (
          <div className="aitw-availability aitw-ok-text">
            <CheckCircleIcon />
            {W.available}
          </div>
        ) : null}
        {canEdit ? <SaveRow saving={saving} dirty={dirty} saved={saved && !dirty} error={error} /> : null}
      </form>
    </SectionFrame>
  );
}

// ---------------------------------------------------------------------------
// 2. Logo and colour
// ---------------------------------------------------------------------------

function BrandingSection({
  company,
  canEdit,
  logoUploads,
  transport,
  tenantId,
  noun,
  announcer,
  onSaved,
  onDirty,
}: {
  company: CompanyWire;
  canEdit: boolean;
  logoUploads: boolean;
  transport: TenancyTransport;
  tenantId: string;
  noun: Noun;
  announcer: Announcer;
  onSaved: (company: CompanyWire) => void;
  onDirty: (dirty: boolean) => void;
}) {
  const fileId = useId();
  const colourId = useId();
  const colourLabelId = useId();
  const [colour, setColour] = useState(company.brandColor ?? "");
  const [savedColour, setSavedColour] = useState(company.brandColor ?? "");
  const [serverReport, setServerReport] = useState<{ colour: string; report: BrandColorReportWire } | null>(null);
  const [colourError, setColourError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [logoBusy, setLogoBusy] = useState<"upload" | "remove" | null>(null);
  const [logoLine, setLogoLine] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  // Known before anyone picks a file (review T1-11): the server says whether
  // uploads are switched on, so the control is disabled with the reason
  // instead of failing after a wait.
  const [storageOff, setStorageOff] = useState<string | null>(
    logoUploads ? null : errorText({ code: "logo_storage_off", message: "" }, noun),
  );

  const normalised = colour.trim() === "" ? null : normaliseHexColor(colour);
  const dirty = (normalised ?? (colour.trim() === "" ? "" : colour)) !== savedColour;
  useEffect(() => onDirty(dirty), [dirty, onDirty]);

  // The client's report while typing; the server's once saved (contract 8.7).
  const report: BrandColorReport | BrandColorReportWire | null =
    normalised && serverReport && serverReport.colour === normalised ? serverReport.report : normalised ? brandColorReport(normalised) : null;

  const logoFailure = (error: ClientError) => {
    const text = errorText(error, noun);
    if (error.code === "logo_storage_off") setStorageOff(text);
    else setLogoLine({ tone: "error", text });
    announcer.fail(text);
  };

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setLogoLine(null);
    setLogoBusy("upload");
    // A phone photo is scaled down here first (see shrinkLogo); only a file
    // that still can't be sent is refused, before the round trip. The server
    // checks the bytes again (an image named .png that isn't one).
    const shrunk = file.type.startsWith("image/") && file.type !== "image/svg+xml" ? await shrinkLogo(file) : null;
    const toSend: Blob | null = shrunk ?? (LOGO_TYPES.includes(file.type) && file.size <= LOGO_MAX_BYTES ? file : null);
    if (!toSend) {
      setLogoBusy(null);
      const text = errorText({ code: "logo_invalid", message: "" }, noun);
      setLogoLine({ tone: "error", text });
      announcer.fail(text);
      return;
    }
    const res = await transport.uploadLogo(tenantId, toSend);
    setLogoBusy(null);
    if (res.ok) {
      onSaved(res.data.company);
      setLogoLine({ tone: "ok", text: SETTINGS.logoUploaded });
      announcer.announce(SETTINGS.logoUploaded);
    } else logoFailure(res.error);
  };

  const removeLogo = async () => {
    setLogoLine(null);
    setLogoBusy("remove");
    const res = await transport.removeLogo(tenantId);
    setLogoBusy(null);
    if (res.ok) {
      onSaved(res.data.company);
      setLogoLine({ tone: "ok", text: SETTINGS.logoRemoved });
      announcer.announce(SETTINGS.logoRemoved);
    } else logoFailure(res.error);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving || !canEdit) return;
    setColourError(null);
    if (colour.trim() !== "" && !normalised) {
      setColourError(SETTINGS.colourInvalid);
      return;
    }
    setSaving(true);
    const res = await transport.updateBranding(tenantId, { brandColor: normalised });
    setSaving(false);
    if (res.ok) {
      onSaved(res.data.company);
      const stored = res.data.company.brandColor ?? "";
      setColour(stored);
      setSavedColour(stored);
      setServerReport(res.data.brand && stored ? { colour: stored, report: res.data.brand } : null);
      setSaved(true);
      announcer.announce(`${SETTINGS.colour}: ${W.saved}.`);
      return;
    }
    setSaved(false);
    const text =
      res.error.code === "invalid" ? (res.error.issues?.find((i) => i.path[0] === "brandColor")?.message ?? errorText(res.error, noun)) : errorText(res.error, noun);
    setColourError(text);
    announcer.fail(text);
  };

  const ratio = report ? Math.max(report.ratioWithWhiteText, report.ratioWithDarkText) : 0;

  return (
    <SectionFrame id="branding" title={SETTINGS.brandingHeading} description={canEdit ? undefined : SETTINGS.readOnly}>
      <div className="aitw-stack-sm">
        <span className="aitw-label">{SETTINGS.logo}</span>
        <div className="aitw-logo-row">
          <div className="aitw-logo-preview" data-aitw-logo="">
            {company.logoUrl ? <img src={company.logoUrl} alt={SETTINGS.logoAlt(company.name)} /> : <span>{SETTINGS.noLogo}</span>}
          </div>
          {canEdit ? (
            <div className="aitw-stack-sm">
              <div className="aitw-actions">
                <span className="aitw-file">
                  <label
                    htmlFor={fileId}
                    className="aitw-btn aitw-btn-secondary"
                    aria-disabled={storageOff !== null || logoBusy !== null ? "true" : undefined}
                  >
                    {logoBusy === "upload" ? SETTINGS.uploading : SETTINGS.uploadLogo}
                  </label>
                  <input
                    id={fileId}
                    type="file"
                    accept="image/*"
                    disabled={storageOff !== null || logoBusy !== null}
                    aria-describedby={`${fileId}-hint`}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = "";
                      void upload(file);
                    }}
                  />
                </span>
                {company.logoUrl ? (
                  <button type="button" className="aitw-btn aitw-btn-danger-outline" disabled={logoBusy !== null} onClick={() => void removeLogo()}>
                    {SETTINGS.removeLogo}
                  </button>
                ) : null}
              </div>
              <span className="aitw-hint" id={`${fileId}-hint`}>
                {SETTINGS.logoHint}
              </span>
            </div>
          ) : null}
        </div>
        {storageOff ? <Notice tone="warn">{storageOff}</Notice> : null}
        {logoLine ? (
          <span className={logoLine.tone === "ok" ? "aitw-ok-text" : "aitw-danger-text"} data-aitw-logo-line="">
            {logoLine.text}
          </span>
        ) : null}
      </div>

      <form className="aitw-form" onSubmit={(event) => void submit(event)} noValidate>
        {/* The typing hint only for someone who can type here (review R2 T1BO-10). */}
        <Field id={colourId} labelId={colourLabelId} label={SETTINGS.colour} hint={canEdit ? SETTINGS.colourHint : undefined} error={colourError}>
          <div className="aitw-colour-row">
            <input
              type="color"
              className="aitw-colour-picker"
              aria-labelledby={colourLabelId}
              disabled={!canEdit}
              // No colour yet: the swatch shows the example colour, not black
              // (review R2 T1BO-10), so it doesn't look like black was chosen.
              value={normalised ?? "#0f766e"}
              onChange={(event) => {
                setColour(event.target.value);
                setSaved(false);
                setColourError(null);
              }}
            />
            <input
              id={colourId}
              className="aitw-input"
              type="text"
              inputMode="text"
              autoComplete="off"
              spellCheck={false}
              maxLength={9}
              placeholder="#0f766e"
              readOnly={!canEdit}
              value={colour}
              aria-invalid={colourError ? true : undefined}
              aria-describedby={describedBy(colourId, canEdit, colourError)}
              onChange={(event) => {
                setColour(event.target.value);
                setSaved(false);
                setColourError(null);
              }}
            />
            {canEdit && colour !== "" ? (
              <button
                type="button"
                className="aitw-btn aitw-btn-link"
                onClick={() => {
                  setColour("");
                  setSaved(false);
                  setColourError(null);
                }}
              >
                {SETTINGS.clearColour}
              </button>
            ) : null}
          </div>
        </Field>

        <div className="aitw-preview" data-aitw-preview="">
          <span className="aitw-label">{SETTINGS.previewHeading}</span>
          {report ? (
            <>
              <div className="aitw-preview-row">
                <span className="aitw-sample-btn" style={{ background: report.color, color: report.textOnColor }} data-aitw-sample="button">
                  {SETTINGS.sampleButton}
                </span>
                {/* The colour as a link on a WHITE page: a customer's page, not this one. */}
                <span className="aitw-sample-page" style={{ background: "#ffffff", color: report.color }} data-aitw-sample="link">
                  {SETTINGS.sampleLink}
                </span>
              </div>
              {/* Words first; the numbers only behind "Contrast numbers" (review
                  T1-15): "13.74 to 1" beside a "hard to read" warning about a
                  different use of the colour read as a contradiction. */}
              <p data-aitw-ratio="">{SETTINGS.readSentence(report.readable)}</p>
              {report.warning ? <Notice tone="warn">{report.warning}</Notice> : null}
              <details className="aitw-more" data-aitw-ratio-details="">
                <summary>{SETTINGS.contrastNumbers}</summary>
                <p className="aitw-hint">{SETTINGS.ratioSentence(formatRatio(ratio), report.readable)}</p>
              </details>
            </>
          ) : colour.trim() !== "" ? (
            // Half-typed ("green", "#0f7"): say so while typing, not only on Save.
            <p className="aitw-sub" data-aitw-colour-pending="">
              {SETTINGS.colourNotYet}
            </p>
          ) : (
            <p className="aitw-sub">{SETTINGS.noColour}</p>
          )}
        </div>
        {canEdit ? <SaveRow saving={saving} dirty={dirty} saved={saved && !dirty} error={null} /> : null}
      </form>
    </SectionFrame>
  );
}

// ---------------------------------------------------------------------------
// 3. Registry sections, rendered from their field specs
// ---------------------------------------------------------------------------

type Values = Record<string, string | number | boolean | null>;

/** The form's text for a stored value: null shows as an empty box. */
function asText(value: string | number | boolean | null | undefined): string {
  return value === null || value === undefined || typeof value === "boolean" ? "" : String(value);
}

/** What Save sends for one field: empty → null, numbers as numbers, toggles as booleans. */
export function wireValue(field: SettingsFieldWire, value: string | number | boolean | null | undefined): string | number | boolean | null {
  if (field.kind === "toggle") return value === true;
  if (field.kind === "number") {
    if (typeof value === "number") return value;
    const text = asText(value).trim();
    if (text === "") return null;
    const n = Number(text);
    return Number.isFinite(n) ? n : text;
  }
  const text = asText(value).trim();
  return text === "" ? null : text;
}

function sameValues(fields: readonly SettingsFieldWire[], a: Values, b: Values): boolean {
  return fields.every((f) => wireValue(f, a[f.key]) === wireValue(f, b[f.key]));
}

function RegistrySection({
  section,
  transport,
  tenantId,
  noun,
  announcer,
  onSaved,
  onDirty,
}: {
  section: SettingsSectionWire;
  transport: TenancyTransport;
  tenantId: string;
  noun: Noun;
  announcer: Announcer;
  onSaved: (section: SettingsSectionWire) => void;
  onDirty: (dirty: boolean) => void;
}) {
  const idBase = useId();
  const [values, setValues] = useState<Values>(section.values);
  const [stored, setStored] = useState<Values>(section.values);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  /**
   * Time zones filled in from this device because none is saved yet (review
   * T1-15): one less thing for an owner to look up. They stay a SUGGESTION —
   * labelled, saved only with the section, and not "unsaved changes" that
   * would make leaving the page ask "are you sure?".
   */
  const [suggested, setSuggested] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!section.canEdit) return;
    const zone = deviceTimeZone();
    if (!zone) return;
    const fill: Record<string, string> = {};
    for (const field of section.fields) {
      if (field.kind === "timezone" && asText(section.values[field.key]) === "") fill[field.key] = zone;
    }
    if (Object.keys(fill).length === 0) return;
    setValues((all) => ({ ...all, ...fill }));
    setSuggested(fill);
    // Once, on mount: after that the person's own choices win.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const withoutSuggestions: Values = { ...values };
  for (const key of Object.keys(suggested)) withoutSuggestions[key] = stored[key] ?? null;
  const dirty = !sameValues(section.fields, withoutSuggestions, stored);
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  const fieldKeys = new Set(section.fields.map((f) => f.key));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving || !section.canEdit) return;
    setErrors({});
    setError(null);
    const body: Values = {};
    for (const field of section.fields) body[field.key] = wireValue(field, values[field.key]);
    setSaving(true);
    const res = await transport.updateSettings(tenantId, section.key, { values: body });
    setSaving(false);
    if (res.ok) {
      setValues(res.data.section.values);
      setStored(res.data.section.values);
      setSuggested({});
      setSaved(true);
      onSaved(res.data.section);
      announcer.announce(`${section.label}: ${W.saved}.`);
      return;
    }
    setSaved(false);
    const e = res.error;
    if (e.code === "invalid" && e.issues?.length) {
      const next: Record<string, string> = {};
      const unplaced: string[] = [];
      for (const issue of e.issues) {
        const key = issue.path[0] === "values" ? issue.path[1] : issue.path[0];
        if (typeof key === "string" && fieldKeys.has(key)) next[key] ??= issue.message;
        else unplaced.push(issue.message);
      }
      setErrors(next);
      setError(unplaced[0] ?? errorText(e, noun));
    } else setError(errorText(e, noun));
    announcer.fail(errorText(e, noun));
  };

  const set = (key: string, value: string | boolean) => {
    setValues((all) => ({ ...all, [key]: value }));
    setSuggested((all) => {
      if (!(key in all)) return all;
      const next = { ...all };
      delete next[key];
      return next;
    });
    setSaved(false);
    setErrors((all) => {
      if (!(key in all)) return all;
      const next = { ...all };
      delete next[key];
      return next;
    });
  };

  return (
    <SectionFrame
      id={sectionAnchor(section.key)}
      title={section.label}
      description={section.description ?? (section.canEdit ? undefined : SETTINGS.sectionReadOnly)}
    >
      <form className="aitw-form" onSubmit={(event) => void submit(event)} noValidate>
        {section.description && !section.canEdit ? <p className="aitw-sub">{SETTINGS.sectionReadOnly}</p> : null}
        <div className="aitw-fields">
          {section.fields.map((field) => (
            <SettingsInput
              key={field.key}
              id={`${idBase}-${field.key}`}
              field={field}
              value={values[field.key]}
              error={errors[field.key] ?? null}
              readOnly={!section.canEdit}
              note={field.key in suggested ? SETTINGS.zoneSuggested : null}
              onChange={(value) => set(field.key, value)}
            />
          ))}
        </div>
        {section.canEdit ? <SaveRow saving={saving} dirty={dirty} saved={saved && !dirty} error={error} /> : null}
      </form>
    </SectionFrame>
  );
}

function SettingsInput({
  id,
  field,
  value,
  error,
  readOnly,
  note,
  onChange,
}: {
  id: string;
  field: SettingsFieldWire;
  value: string | number | boolean | null | undefined;
  error: string | null;
  readOnly: boolean;
  /** An extra line after the field's own help (the suggested time zone). */
  note?: string | null;
  onChange: (value: string | boolean) => void;
}) {
  const help = [field.help, note].filter((part): part is string => Boolean(part)).join(" ") || null;
  field = { ...field, help };
  const describe = describedBy(id, Boolean(field.help), error);
  const common = {
    id,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": describe,
    "aria-required": field.required || undefined,
  } as const;

  if (field.kind === "toggle") {
    return (
      <div className="aitw-field" data-width={field.width} data-field={field.key}>
        <label className="aitw-check" htmlFor={id}>
          <input {...common} type="checkbox" checked={value === true} disabled={readOnly} onChange={(event) => onChange(event.target.checked)} />
          <span className="aitw-label">{field.label}</span>
        </label>
        {field.help ? (
          <span className="aitw-hint" id={`${id}-hint`}>
            {field.help}
          </span>
        ) : null}
        {error ? (
          <span className="aitw-field-error" id={`${id}-error`}>
            {error}
          </span>
        ) : null}
      </div>
    );
  }

  let control: ReactNode;
  if (field.kind === "textarea") {
    control = (
      <textarea {...common} className="aitw-input" readOnly={readOnly} placeholder={field.placeholder ?? undefined} value={asText(value)} onChange={(event) => onChange(event.target.value)} />
    );
  } else if (field.kind === "select") {
    control = (
      <select {...common} className="aitw-input" disabled={readOnly} value={asText(value)} onChange={(event) => onChange(event.target.value)}>
        <option value="">{field.placeholder ?? ""}</option>
        {(field.options ?? []).map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  } else if (field.kind === "timezone") {
    control = <TimeZoneSelect common={common} value={asText(value)} readOnly={readOnly} onChange={onChange} />;
  } else {
    control = (
      <input
        {...common}
        className="aitw-input"
        type={field.kind === "number" ? "number" : field.kind}
        readOnly={readOnly}
        autoComplete={field.autoComplete ?? undefined}
        placeholder={field.placeholder ?? undefined}
        min={field.min ?? undefined}
        max={field.max ?? undefined}
        step={field.step ?? undefined}
        inputMode={field.kind === "tel" ? "tel" : field.kind === "email" ? "email" : field.kind === "number" ? "decimal" : undefined}
        value={asText(value)}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }
  return (
    <Field id={id} label={field.label} hint={field.help ?? undefined} error={error} width={field.width}>
      {control}
    </Field>
  );
}

/**
 * The US zones by the name people say, then every other zone the browser
 * knows; the stored value is always an option, even one this browser has
 * never heard of, so opening the page never silently changes it.
 */
function TimeZoneSelect({
  common,
  value,
  readOnly,
  onChange,
}: {
  common: { id: string; "aria-invalid"?: boolean; "aria-describedby"?: string; "aria-required"?: boolean };
  value: string;
  readOnly: boolean;
  onChange: (value: string) => void;
}) {
  const us = new Set(US_TIME_ZONES.map((z) => z.zone));
  // The full list only after mount: the server's and the browser's ICU can
  // know different zones, and a list that differs by one option makes React
  // discard the server-rendered page.
  const mounted = useMounted();
  // Readable places, sorted (review R2 T1BO-10): "Buenos Aires, Argentina
  // (Argentina Standard Time)", not "America/Argentina/Buenos_Aires".
  const others = mounted ? otherTimeZoneChoices(us) : [];
  const known = value === "" || us.has(value) || others.some((z) => z.zone === value);
  return (
    <select {...common} className="aitw-input" disabled={readOnly} value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">{SETTINGS.chooseZone}</option>
      {known ? null : <option value={value}>{zoneOptionLabel(value)}</option>}
      <optgroup label={SETTINGS.usZones}>
        {US_TIME_ZONES.map((zone) => (
          <option key={zone.zone} value={zone.zone}>
            {zone.label}
          </option>
        ))}
      </optgroup>
      {others.length > 0 ? (
        <optgroup label={SETTINGS.otherZones}>
          {others.map((zone) => (
            <option key={zone.zone} value={zone.zone}>
              {zone.label}
            </option>
          ))}
        </optgroup>
      ) : null}
    </select>
  );
}
