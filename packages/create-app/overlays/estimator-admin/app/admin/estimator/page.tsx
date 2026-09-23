"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/trpc/client";
import {
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  Input,
  Notice,
  PageHeader,
} from "@/components/ui";

/**
 * The price book — the estimator's catalog, editable by staff. This is what
 * turns the estimator from a demo into a product a buyer runs: create the
 * things you sell, set the rates, attach the materials, and the public tool and
 * the pricing engine follow from these rows. Money is entered in dollars and
 * stored in cents; percentages are entered as percents and stored as basis
 * points — the conversions live here so the rest of the stack stays in its
 * canonical units.
 */

const MODES = [
  { value: "area", label: "Area (width × height)" },
  { value: "linear", label: "Linear feet" },
  { value: "unit", label: "Per unit / count" },
] as const;
const UNIT_TYPES = [
  { value: "flat", label: "Flat" },
  { value: "per_unit", label: "Per unit" },
  { value: "per_sqft", label: "Per sq ft" },
  { value: "per_linear_ft", label: "Per linear ft" },
] as const;

const toCents = (dollars: string): number => Math.max(0, Math.round((Number(dollars) || 0) * 100));
const fromCents = (cents: number | null | undefined): string =>
  cents == null ? "" : (cents / 100).toString();
const toBp = (percent: string): number => Math.max(0, Math.round((Number(percent) || 0) * 100));
const fromBp = (bp: number): string => (bp / 100).toString();
const usd = (cents: number): string =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);

const selectClass =
  "rounded-control border border-line-strong bg-surface px-2 py-1.5 text-sm text-ink";

export default function EstimatorAdminPage() {
  const products = api.estimator.products.useQuery();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  return (
    <>
      <PageHeader
        title="Price book"
        description="The estimator's catalog: the things you sell, their rates, and the materials each one uses. The public tool and the pricing engine run on these rows."
        actions={
          <Link href="/admin/estimates" className="text-sm text-accent underline underline-offset-2">
            Estimates →
          </Link>
        }
      />

      <div className="flex flex-col gap-6">
        <EmbedKeys />
        <ComponentsLibrary />

        <Card>
          <CardBody className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-ink">Products</h2>
              <Button variant="primary" onClick={() => { setCreating(true); setSelectedId(null); }}>
                New product
              </Button>
            </div>

            {products.isLoading ? (
              <p className="text-sm text-ink-muted">Loading the catalog…</p>
            ) : (products.data ?? []).length === 0 ? (
              <EmptyState title="No products yet">Create your first product to price against.</EmptyState>
            ) : (
              <div className="flex flex-col divide-y divide-line">
                {(products.data ?? []).map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => { setSelectedId(p.id); setCreating(false); }}
                    className={`flex items-center gap-2 px-1 py-2 text-left text-sm ${
                      selectedId === p.id ? "text-accent" : "text-ink hover:text-accent"
                    }`}
                  >
                    <span className="font-medium">{p.name}</span>
                    <span className="text-xs text-ink-faint">{p.category ?? ""}</span>
                    <span className="ml-auto flex items-center gap-2">
                      {!p.isEstimatable ? <Badge tone="neutral">quote only</Badge> : null}
                      {!p.showInEstimator ? <Badge tone="neutral">hidden</Badge> : null}
                      <span className="font-mono text-xs text-ink-faint">
                        {p.measurementMode}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </CardBody>
        </Card>

        {creating ? (
          <ProductForm
            onSaved={(id) => { setCreating(false); setSelectedId(id); void products.refetch(); }}
            onCancel={() => setCreating(false)}
          />
        ) : null}

        {selectedId ? (
          <ProductEditor
            key={selectedId}
            productId={selectedId}
            onChanged={() => void products.refetch()}
            onDeactivated={() => { setSelectedId(null); void products.refetch(); }}
          />
        ) : null}
      </div>
    </>
  );
}

function EmbedKeys() {
  const keys = api.estimator.clientKeys.useQuery();
  const issue = api.estimator.issueClientKey.useMutation();
  const revoke = api.estimator.revokeClientKey.useMutation();
  const [label, setLabel] = useState("");
  const [issued, setIssued] = useState<{ label: string; key: string } | null>(null);

  const create = async () => {
    if (!label.trim()) return;
    const result = await issue.mutateAsync({ label: label.trim() });
    setIssued({ label: result.label, key: result.key });
    setLabel("");
    void keys.refetch();
  };

  return (
    <Card>
      <CardBody className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-ink">Embed keys</h2>
        <p className="text-xs text-ink-muted">
          Issue a key to run the instant-estimate widget on a customer&rsquo;s own website. The key
          is shown once — copy it now. Revoke it and the widget goes dark on the next request.
        </p>

        {issued ? (
          <Notice tone="info" title={`Key for “${issued.label}” — copy it now, it won't be shown again`}>
            <code className="mt-1 block break-all rounded-control border border-line bg-surface px-2 py-1 font-mono text-xs">
              {issued.key}
            </code>
          </Notice>
        ) : null}

        <div className="flex flex-col gap-1.5">
          {(keys.data ?? []).map((k) => (
            <div key={k.id} className="flex flex-wrap items-center gap-2 rounded-control border border-line px-3 py-1.5 text-sm">
              <span className="text-ink">{k.label}</span>
              <span className="font-mono text-xs text-ink-faint">{k.keyPrefix}…</span>
              {k.revokedAt ? (
                <Badge tone="danger">revoked</Badge>
              ) : (
                <Badge tone="accent">active</Badge>
              )}
              <span className="text-xs text-ink-faint">
                {k.lastUsedAt ? `used ${new Date(k.lastUsedAt).toLocaleDateString()}` : "never used"}
              </span>
              {!k.revokedAt ? (
                <Button variant="danger" className="ml-auto" onClick={() => void revoke.mutateAsync({ id: k.id }).then(() => keys.refetch())}>
                  Revoke
                </Button>
              ) : null}
            </div>
          ))}
        </div>

        <div className="flex flex-wrap items-end gap-2 border-t border-line pt-3">
          <Input placeholder="Key label (e.g. Acme Ramps site)" value={label} onChange={(e) => setLabel(e.target.value)} className="w-64" />
          <Button variant="primary" disabled={!label.trim() || issue.isPending} onClick={() => void create()}>
            Issue key
          </Button>
        </div>

        <details className="text-xs text-ink-muted">
          <summary className="cursor-pointer">How to embed the widget</summary>
          <pre className="mt-2 overflow-x-auto rounded-control border border-line bg-surface p-3 font-mono text-[11px] text-ink-muted">
{`import { EstimatorProvider, EstimatorButton, EstimatorModal } from "__SCOPE__/estimator-widget";

<EstimatorProvider config={{
  baseUrl: "https://adminigloo.com/api/estimator/embed",
  clientKey: process.env.NEXT_PUBLIC_ESTIMATOR_KEY,
}}>
  <EstimatorButton />
  <EstimatorModal />
</EstimatorProvider>`}
          </pre>
        </details>
      </CardBody>
    </Card>
  );
}

function ComponentsLibrary() {
  const components = api.estimator.components.useQuery();
  const create = api.estimator.createComponent.useMutation();
  const remove = api.estimator.deactivateComponent.useMutation();
  const [name, setName] = useState("");
  const [unitType, setUnitType] = useState("flat");
  const [unitCost, setUnitCost] = useState("");

  const add = async () => {
    if (!name.trim()) return;
    await create.mutateAsync({ name: name.trim(), unitType: unitType as (typeof UNIT_TYPES)[number]["value"], unitCost: toCents(unitCost) });
    setName(""); setUnitCost(""); setUnitType("flat");
    void components.refetch();
  };

  return (
    <Card>
      <CardBody className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-ink">Materials</h2>
        <p className="text-xs text-ink-muted">
          Reusable line items — railing, a landing, a permit — you attach to products below.
        </p>
        <div className="flex flex-col gap-2">
          {(components.data ?? []).map((c) => (
            <div key={c.id} className="flex items-center gap-2 rounded-control border border-line px-3 py-1.5 text-sm">
              <span className="text-ink">{c.name}</span>
              <span className="font-mono text-xs text-ink-faint">{c.unitType}</span>
              <span className="ml-auto font-mono text-xs tabular-nums">{usd(c.unitCost)}</span>
              <Button variant="danger" onClick={() => void remove.mutateAsync({ id: c.id }).then(() => components.refetch())}>
                Remove
              </Button>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-2 border-t border-line pt-3">
          <Input placeholder="Material name" value={name} onChange={(e) => setName(e.target.value)} className="w-48" />
          <select value={unitType} onChange={(e) => setUnitType(e.target.value)} className={selectClass}>
            {UNIT_TYPES.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
          </select>
          <Input placeholder="Unit cost $" type="number" min="0" value={unitCost} onChange={(e) => setUnitCost(e.target.value)} className="w-28" />
          <Button variant="primary" disabled={!name.trim() || create.isPending} onClick={() => void add()}>
            Add material
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

interface ProductFields {
  name: string;
  category: string;
  description: string;
  measurementMode: string;
  basePrice: string;
  pricePerSqFt: string;
  pricePerLinearFt: string;
  laborCost: string;
  wastePct: string;
  markupPct: string;
  minimumCharge: string;
  lowPct: string;
  highPct: string;
  showInEstimator: boolean;
  isEstimatable: boolean;
}

const EMPTY_FIELDS: ProductFields = {
  name: "", category: "", description: "", measurementMode: "area",
  basePrice: "", pricePerSqFt: "", pricePerLinearFt: "", laborCost: "",
  wastePct: "0", markupPct: "0", minimumCharge: "", lowPct: "90", highPct: "115",
  showInEstimator: true, isEstimatable: true,
};

function fieldsToInput(f: ProductFields) {
  return {
    name: f.name.trim(),
    category: f.category.trim() || null,
    description: f.description.trim() || null,
    measurementMode: f.measurementMode as "area" | "linear" | "unit",
    basePrice: toCents(f.basePrice),
    pricePerSqFt: f.pricePerSqFt.trim() === "" ? null : toCents(f.pricePerSqFt),
    pricePerLinearFt: f.pricePerLinearFt.trim() === "" ? null : toCents(f.pricePerLinearFt),
    laborCost: toCents(f.laborCost),
    wasteBp: toBp(f.wastePct),
    markupBp: toBp(f.markupPct),
    minimumCharge: toCents(f.minimumCharge),
    estimateLowBp: toBp(f.lowPct),
    estimateHighBp: toBp(f.highPct),
    showInEstimator: f.showInEstimator,
    isEstimatable: f.isEstimatable,
  };
}

function ProductForm({ onSaved, onCancel }: { onSaved: (id: string) => void; onCancel: () => void }) {
  const create = api.estimator.createProduct.useMutation();
  const [f, setF] = useState<ProductFields>(EMPTY_FIELDS);
  const set = <K extends keyof ProductFields>(k: K, v: ProductFields[K]) => setF((prev) => ({ ...prev, [k]: v }));

  const save = async () => {
    if (!f.name.trim()) return;
    const product = await create.mutateAsync(fieldsToInput(f));
    onSaved(product.id);
  };

  return (
    <Card>
      <CardBody className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-ink">New product</h2>
        <FieldsGrid f={f} set={set} />
        <div className="flex gap-2">
          <Button variant="primary" disabled={!f.name.trim() || create.isPending} onClick={() => void save()}>
            {create.isPending ? "Creating…" : "Create product"}
          </Button>
          <Button onClick={onCancel}>Cancel</Button>
        </div>
      </CardBody>
    </Card>
  );
}

function FieldsGrid({ f, set }: { f: ProductFields; set: <K extends keyof ProductFields>(k: K, v: ProductFields[K]) => void }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Labeled label="Name"><Input value={f.name} onChange={(e) => set("name", e.target.value)} /></Labeled>
        <Labeled label="Category"><Input value={f.category} onChange={(e) => set("category", e.target.value)} /></Labeled>
      </div>
      <Labeled label="Description"><Input value={f.description} onChange={(e) => set("description", e.target.value)} /></Labeled>
      <div className="flex flex-wrap items-end gap-3">
        <Labeled label="Measured by">
          <select value={f.measurementMode} onChange={(e) => set("measurementMode", e.target.value)} className={selectClass}>
            {MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </Labeled>
        <Labeled label="Base price $"><Input type="number" min="0" value={f.basePrice} onChange={(e) => set("basePrice", e.target.value)} className="w-28" /></Labeled>
        <Labeled label="Per sq ft $"><Input type="number" min="0" value={f.pricePerSqFt} onChange={(e) => set("pricePerSqFt", e.target.value)} className="w-24" /></Labeled>
        <Labeled label="Per linear ft $"><Input type="number" min="0" value={f.pricePerLinearFt} onChange={(e) => set("pricePerLinearFt", e.target.value)} className="w-24" /></Labeled>
        <Labeled label="Labor $"><Input type="number" min="0" value={f.laborCost} onChange={(e) => set("laborCost", e.target.value)} className="w-24" /></Labeled>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <Labeled label="Waste %"><Input type="number" min="0" value={f.wastePct} onChange={(e) => set("wastePct", e.target.value)} className="w-20" /></Labeled>
        <Labeled label="Markup %"><Input type="number" min="0" value={f.markupPct} onChange={(e) => set("markupPct", e.target.value)} className="w-20" /></Labeled>
        <Labeled label="Minimum $"><Input type="number" min="0" value={f.minimumCharge} onChange={(e) => set("minimumCharge", e.target.value)} className="w-24" /></Labeled>
        <Labeled label="Range low %"><Input type="number" min="0" value={f.lowPct} onChange={(e) => set("lowPct", e.target.value)} className="w-20" /></Labeled>
        <Labeled label="Range high %"><Input type="number" min="0" value={f.highPct} onChange={(e) => set("highPct", e.target.value)} className="w-20" /></Labeled>
      </div>
      <div className="flex flex-wrap gap-4 text-sm text-ink">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={f.showInEstimator} onChange={(e) => set("showInEstimator", e.target.checked)} />
          Show in the public tool
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={f.isEstimatable} onChange={(e) => set("isEstimatable", e.target.checked)} />
          Priceable (unchecked = &ldquo;request a quote&rdquo;)
        </label>
      </div>
    </div>
  );
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium uppercase tracking-wider text-ink-faint">
      {label}
      {children}
    </label>
  );
}

function ProductEditor({
  productId,
  onChanged,
  onDeactivated,
}: {
  productId: string;
  onChanged: () => void;
  onDeactivated: () => void;
}) {
  const detail = api.estimator.productDetail.useQuery({ productId });
  const update = api.estimator.updateProduct.useMutation();
  const deactivate = api.estimator.deactivateProduct.useMutation();
  const components = api.estimator.components.useQuery();
  const attach = api.estimator.attachComponent.useMutation();
  const detach = api.estimator.detachComponent.useMutation();
  const createOption = api.estimator.createOption.useMutation();
  const createOptionValue = api.estimator.createOptionValue.useMutation();

  const [f, setF] = useState<ProductFields | null>(null);
  const set = <K extends keyof ProductFields>(k: K, v: ProductFields[K]) => setF((prev) => (prev ? { ...prev, [k]: v } : prev));
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const p = detail.data?.product;
    if (p) {
      setF({
        name: p.name, category: p.category ?? "", description: p.description ?? "",
        measurementMode: p.measurementMode, basePrice: fromCents(p.basePrice),
        pricePerSqFt: fromCents(p.pricePerSqFt), pricePerLinearFt: fromCents(p.pricePerLinearFt),
        laborCost: fromCents(p.laborCost), wastePct: fromBp(p.wasteBp), markupPct: fromBp(p.markupBp),
        minimumCharge: fromCents(p.minimumCharge), lowPct: fromBp(p.estimateLowBp), highPct: fromBp(p.estimateHighBp),
        showInEstimator: p.showInEstimator, isEstimatable: p.isEstimatable,
      });
    }
  }, [detail.data]);

  const [attachId, setAttachId] = useState("");
  const [attachQty, setAttachQty] = useState("1");
  const [optName, setOptName] = useState("");
  const [valFor, setValFor] = useState<string>("");
  const [valLabel, setValLabel] = useState("");
  const [valPrice, setValPrice] = useState("");

  if (detail.isLoading || !f) return <Card><CardBody>Loading…</CardBody></Card>;
  if (!detail.data) return <Notice tone="warn">That product no longer exists.</Notice>;

  const save = async () => {
    setSaved(false);
    await update.mutateAsync({ id: productId, patch: fieldsToInput(f) });
    setSaved(true);
    onChanged();
    void detail.refetch();
  };

  return (
    <Card>
      <CardBody className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink">Edit: {detail.data.product.name}</h2>
          <Button variant="danger" onClick={() => void deactivate.mutateAsync({ id: productId }).then(onDeactivated)}>
            Deactivate
          </Button>
        </div>

        <FieldsGrid f={f} set={set} />
        <div className="flex items-center gap-3">
          <Button variant="primary" disabled={update.isPending} onClick={() => void save()}>
            {update.isPending ? "Saving…" : "Save changes"}
          </Button>
          {saved ? <span className="text-xs text-accent">Saved.</span> : null}
        </div>

        {/* Materials on this product */}
        <div className="border-t border-line pt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-faint">Materials on this product</h3>
          <div className="mt-2 flex flex-col gap-1.5">
            {detail.data.components.length === 0 ? (
              <p className="text-sm text-ink-muted">None attached.</p>
            ) : (
              detail.data.components.map((c) => (
                <div key={c.assignmentId} className="flex items-center gap-2 rounded-control border border-line px-3 py-1.5 text-sm">
                  <span className="text-ink">{c.component.name}</span>
                  <span className="font-mono text-xs text-ink-faint">{c.component.unitType} · {usd(c.component.unitCost)} × {(c.quantityMilli / 1000).toString()}</span>
                  <Button variant="danger" className="ml-auto" onClick={() => void detach.mutateAsync({ assignmentId: c.assignmentId }).then(() => detail.refetch())}>
                    Detach
                  </Button>
                </div>
              ))
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <select value={attachId} onChange={(e) => setAttachId(e.target.value)} className={selectClass}>
              <option value="">Attach a material…</option>
              {(components.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <Input type="number" min="1" step="0.1" value={attachQty} onChange={(e) => setAttachQty(e.target.value)} className="w-20" placeholder="Qty ×" />
            <Button
              disabled={!attachId || attach.isPending}
              onClick={() =>
                void attach
                  .mutateAsync({ productId, componentId: attachId, quantityMilli: Math.max(1, Math.round((Number(attachQty) || 1) * 1000)) })
                  .then(() => { setAttachId(""); setAttachQty("1"); void detail.refetch(); })
              }
            >
              Attach
            </Button>
          </div>
        </div>

        {/* Options */}
        <div className="border-t border-line pt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-faint">Options</h3>
          <div className="mt-2 flex flex-col gap-2">
            {detail.data.options.map((o) => (
              <div key={o.option.id} className="rounded-control border border-line px-3 py-2">
                <p className="text-sm font-medium text-ink">{o.option.name}</p>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {o.values.map((v) => (
                    <span key={v.id} className="rounded-pill border border-line px-2 py-0.5 text-xs text-ink-muted">
                      {v.label}{v.priceModifier > 0 ? ` +${usd(v.priceModifier)}` : ""}{v.isDefault ? " · default" : ""}
                    </span>
                  ))}
                </div>
                <div className="mt-2 flex flex-wrap items-end gap-2">
                  <Input placeholder="Value label" value={valFor === o.option.id ? valLabel : ""} onFocus={() => setValFor(o.option.id)} onChange={(e) => { setValFor(o.option.id); setValLabel(e.target.value); }} className="w-40" />
                  <Input placeholder="+ $" type="number" min="0" value={valFor === o.option.id ? valPrice : ""} onChange={(e) => { setValFor(o.option.id); setValPrice(e.target.value); }} className="w-20" />
                  <Button
                    disabled={valFor !== o.option.id || !valLabel.trim() || createOptionValue.isPending}
                    onClick={() =>
                      void createOptionValue
                        .mutateAsync({ optionId: o.option.id, label: valLabel.trim(), priceModifier: toCents(valPrice) })
                        .then(() => { setValLabel(""); setValPrice(""); void detail.refetch(); })
                    }
                  >
                    Add value
                  </Button>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <Input placeholder="New option (e.g. Finish)" value={optName} onChange={(e) => setOptName(e.target.value)} className="w-48" />
            <Button
              disabled={!optName.trim() || createOption.isPending}
              onClick={() =>
                void createOption
                  .mutateAsync({ productId, name: optName.trim() })
                  .then(() => { setOptName(""); void detail.refetch(); })
              }
            >
              Add option
            </Button>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}
