"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/trpc/client";
import { Button, Card, CardBody, Input, Notice } from "@/components/ui";

/**
 * The public instant-estimate tool — the customer-facing half of
 * __SCOPE__/estimator, used both on /estimate and as the live demo on the
 * feature page. Pick a product, enter a measurement (the fields follow the
 * product's measurement mode), watch the range update live off the real engine,
 * then optionally save it as a lead. Every number is the server's; nothing is
 * priced in the browser.
 */

function usd(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

export function EstimateTool({ compact = false }: { readonly compact?: boolean }) {
  const products = api.estimator.publicProducts.useQuery();
  const [productId, setProductId] = useState<string>("");

  const product = useMemo(
    () => products.data?.find((p) => p.id === productId) ?? null,
    [products.data, productId],
  );

  // Pick the first estimatable product once the catalog loads.
  useEffect(() => {
    if (!productId && products.data && products.data.length > 0) {
      const first = products.data.find((p) => p.isEstimatable) ?? products.data[0];
      if (first) setProductId(first.id);
    }
  }, [products.data, productId]);

  const [widthIn, setWidthIn] = useState("36");
  const [heightIn, setHeightIn] = useState("30");
  const [linearFt, setLinearFt] = useState("20");
  const [quantity, setQuantity] = useState("1");
  const [choices, setChoices] = useState<Record<string, string>>({});

  const options = api.estimator.publicOptions.useQuery(
    { productId },
    { enabled: Boolean(productId) && Boolean(product?.isEstimatable) },
  );

  // Default each option to its marked default (or first) when options arrive.
  useEffect(() => {
    if (!options.data) return;
    setChoices((prev) => {
      const next = { ...prev };
      for (const opt of options.data) {
        if (!next[opt.id]) {
          const def = opt.values.find((v) => v.isDefault) ?? opt.values[0];
          if (def) next[opt.id] = def.id;
        }
      }
      return next;
    });
  }, [options.data]);

  const mode = product?.measurementMode ?? "area";
  const qty = Math.max(1, Number(quantity) || 1);

  // A measurement describes ONE of the product; "How many" is the quantity. A
  // unit-mode product therefore sends no measurement — sending the count as
  // `units` too would bill any per-unit material quantity² times.
  const measurement = useMemo(() => {
    if (mode === "linear") return { linearFt: Number(linearFt) || 0 };
    if (mode === "unit") return {};
    return { widthIn: Number(widthIn) || 0, heightIn: Number(heightIn) || 0 };
  }, [mode, linearFt, widthIn, heightIn]);

  const optionValueIds = useMemo(() => Object.values(choices), [choices]);

  const measurementValid =
    mode === "linear"
      ? (Number(linearFt) || 0) > 0
      : mode === "unit"
        ? qty > 0
        : (Number(widthIn) || 0) > 0 && (Number(heightIn) || 0) > 0;

  const canPrice = Boolean(product?.isEstimatable) && measurementValid;

  const estimate = api.estimator.calculate.useQuery(
    { productId, measurement, quantity: qty, optionValueIds },
    { enabled: Boolean(productId) && canPrice },
  );

  // --- Save-as-lead ---
  const submit = api.estimator.submit.useMutation();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [savedNumber, setSavedNumber] = useState<string | null>(null);
  const [savedEstimateId, setSavedEstimateId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The estimate → book-a-visit step lives with the project, not this overlay:
  // it needs the scheduling feature. Generate with `--scheduling` and wire a
  // slot picker into the "saved" state below (api.scheduling.slots / requestBooking).

  // --- Photo takeoff ---
  interface Takeoff {
    sqFt: number | null;
    linearFt: number | null;
    units: number | null;
    confidence: string;
    summary: string;
    assumptions: string[];
  }
  const [takeoffBusy, setTakeoffBusy] = useState(false);
  const [takeoff, setTakeoff] = useState<Takeoff | null>(null);
  const [takeoffMsg, setTakeoffMsg] = useState<string | null>(null);

  const onPhoto = async (file: File) => {
    setTakeoffMsg(null);
    setTakeoff(null);
    if (!product) return;
    if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.type)) {
      setTakeoffMsg("Please use a JPEG, PNG, WEBP, or GIF photo.");
      return;
    }
    if (file.size > 5_000_000) {
      setTakeoffMsg("That image is a bit large — please use one under 5 MB.");
      return;
    }
    setTakeoffBusy(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      const base64 = dataUrl.split(",")[1] ?? "";
      const resp = await fetch("/api/estimator/takeoff", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ productId: product.id, imageBase64: base64, mediaType: file.type }),
      });
      const data = (await resp.json()) as { available?: boolean; result?: Takeoff | null; error?: string };
      if (!resp.ok) {
        setTakeoffMsg(data.error ?? "Couldn't read that photo. Enter the measurement by hand.");
        return;
      }
      if (data.available === false) {
        setTakeoffMsg("Photo estimates aren't switched on here — enter the measurement by hand.");
        return;
      }
      if (!data.result) {
        setTakeoffMsg("I couldn't get a measurement from that photo — enter it by hand and I'll price it.");
        return;
      }
      const r = data.result;
      setTakeoff(r);
      if (mode === "linear" && r.linearFt) {
        setLinearFt(String(Math.round(r.linearFt)));
      } else if (mode === "unit" && r.units) {
        setQuantity(String(Math.max(1, Math.round(r.units))));
      } else if (mode === "area" && r.sqFt) {
        // Back-solve a square so the width/height fields stay meaningful and
        // editable; the AREA (what's priced) is what the photo actually gave us.
        const side = Math.max(1, Math.round(Math.sqrt(r.sqFt) * 12));
        setWidthIn(String(side));
        setHeightIn(String(side));
      }
    } catch {
      setTakeoffMsg("Couldn't read that photo. Enter the measurement by hand.");
    } finally {
      setTakeoffBusy(false);
    }
  };

  const save = async () => {
    setError(null);
    if (!product) return;
    // The server refuses a lead nobody can call back; say so before sending.
    if (!name.trim() || (!email.trim() && !phone.trim())) {
      setError("Please add your name and an email or phone number so we can reach you.");
      return;
    }
    try {
      // Only WHAT you want goes up — the server prices it, the same way it
      // priced the range above.
      const result = await submit.mutateAsync({
        customerName: name.trim(),
        customerEmail: email.trim() || null,
        customerPhone: phone.trim() || null,
        jobAddress: address.trim() || null,
        source: "public_tool",
        items: [
          {
            productId: product.id,
            description: product.name,
            measurement,
            quantity: qty,
            optionValueIds,
          },
        ],
      });
      setSavedNumber(result.estimateNumber);
      setSavedEstimateId(result.id);
    } catch {
      setError("Something went wrong saving that. Please try again, or give us a call.");
    }
  };

  if (products.isLoading) {
    return <p className="text-sm text-ink-muted">Loading the estimator…</p>;
  }
  if (!products.data || products.data.length === 0) {
    return (
      <Notice tone="warn">
        No estimatable products are set up yet. Add products in the estimator admin.
      </Notice>
    );
  }

  const low = estimate.data?.estimateLow ?? null;
  const high = estimate.data?.estimateHigh ?? null;

  return (
    <div className="flex flex-col gap-4">
      {/* Product picker */}
      <div>
        <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-ink-faint">
          What do you need?
        </label>
        <div className="flex flex-wrap gap-2">
          {products.data.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => {
                setProductId(p.id);
                setSavedNumber(null);
                setShowForm(false);
                setTakeoff(null);
                setTakeoffMsg(null);
              }}
              className={
                p.id === productId
                  ? "rounded-control border border-accent bg-accent-soft px-3 py-1.5 text-sm font-medium text-accent"
                  : "rounded-control border border-line bg-surface px-3 py-1.5 text-sm text-ink-muted hover:border-line-strong hover:text-ink"
              }
            >
              {p.name}
            </button>
          ))}
        </div>
        {product?.description ? (
          <p className="mt-2 text-sm text-ink-muted">{product.description}</p>
        ) : null}
      </div>

      {product && !product.isEstimatable ? (
        <Notice tone="info">
          This one needs a quick look to price fairly — leave your details below and we&rsquo;ll reach out.
        </Notice>
      ) : null}

      {/* Photo takeoff — fills the measurement from a picture. */}
      {product?.isEstimatable ? (
        <div className="rounded-[--radius-card] border border-dashed border-line-strong bg-canvas px-4 py-3">
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium text-ink">Estimate from a photo</span>
            <span className="text-xs text-ink-muted">
              Snap the staircase or the space and we&rsquo;ll fill in the measurement — adjust it if you know it exactly.
            </span>
            <input
              type="file"
              accept="image/*"
              disabled={takeoffBusy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void onPhoto(file);
              }}
              className="mt-1.5 text-xs text-ink-muted file:mr-3 file:rounded-control file:border file:border-line-strong file:bg-surface file:px-3 file:py-1.5 file:text-sm file:text-ink hover:file:bg-canvas"
            />
          </label>
          {takeoffBusy ? <p className="mt-2 text-xs text-accent">Reading your photo…</p> : null}
          {takeoffMsg ? <p className="mt-2 text-xs text-ink-muted">{takeoffMsg}</p> : null}
          {takeoff ? (
            <div className="mt-2 rounded-control border border-line bg-surface px-3 py-2 text-xs">
              <p className="text-ink">
                {takeoff.summary}{" "}
                <span className="text-ink-faint">({takeoff.confidence} confidence)</span>
              </p>
              {takeoff.assumptions.length > 0 ? (
                <ul className="mt-1 list-disc pl-4 text-ink-muted">
                  {takeoff.assumptions.map((a, i) => (
                    <li key={i}>{a}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Measurement */}
      {product?.isEstimatable ? (
        <div className="flex flex-wrap items-end gap-3">
          {mode === "area" ? (
            <>
              <Field label="Width (in)">
                <Input type="number" min="0" value={widthIn} onChange={(e) => setWidthIn(e.target.value)} className="w-24" />
              </Field>
              <Field label="Height (in)">
                <Input type="number" min="0" value={heightIn} onChange={(e) => setHeightIn(e.target.value)} className="w-24" />
              </Field>
              <Field label="How many">
                <Input type="number" min="1" value={quantity} onChange={(e) => setQuantity(e.target.value)} className="w-20" />
              </Field>
            </>
          ) : mode === "linear" ? (
            <>
              <Field label="Length of run (ft)">
                <Input type="number" min="0" value={linearFt} onChange={(e) => setLinearFt(e.target.value)} className="w-28" />
              </Field>
              <Field label="How many">
                <Input type="number" min="1" value={quantity} onChange={(e) => setQuantity(e.target.value)} className="w-20" />
              </Field>
            </>
          ) : (
            <Field label="How many">
              <Input type="number" min="1" value={quantity} onChange={(e) => setQuantity(e.target.value)} className="w-24" />
            </Field>
          )}
        </div>
      ) : null}

      {/* Options */}
      {product?.isEstimatable && options.data && options.data.length > 0 ? (
        <div className="flex flex-col gap-3">
          {options.data.map((opt) => (
            <div key={opt.id}>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-ink-faint">
                {opt.name}
              </label>
              <div className="flex flex-wrap gap-2">
                {opt.values.map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() => setChoices((c) => ({ ...c, [opt.id]: v.id }))}
                    className={
                      choices[opt.id] === v.id
                        ? "rounded-control border border-accent bg-accent-soft px-2.5 py-1 text-xs font-medium text-accent"
                        : "rounded-control border border-line bg-surface px-2.5 py-1 text-xs text-ink-muted hover:text-ink"
                    }
                  >
                    {v.label}
                    {v.priceModifier > 0 ? <span className="ml-1 text-ink-faint">+{usd(v.priceModifier)}</span> : null}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {/* The range */}
      {product?.isEstimatable ? (
        <div className="rounded-[--radius-card] border border-line bg-canvas px-4 py-4">
          <p className="text-xs font-medium uppercase tracking-wider text-ink-faint">Estimated ballpark</p>
          {low !== null && high !== null ? (
            <p className="mt-1 text-2xl font-semibold tabular-nums text-ink" style={{ fontFamily: "var(--font-display)" }}>
              {usd(low)} <span className="text-ink-faint">–</span> {usd(high)}
            </p>
          ) : (
            <p className="mt-1 text-sm text-ink-muted">Enter a measurement to see a range.</p>
          )}
          <p className="mt-1 text-xs text-ink-faint">
            A real ballpark from our price book — not a mockup. Final pricing is confirmed on a site visit.
          </p>
        </div>
      ) : null}

      {/* Save as lead. The estimate → book-a-visit step is a cross-feature
          flow: generate with `--scheduling` and add a slot picker here that
          calls `api.scheduling.slots` / `requestBooking` (see the scheduling
          overlay's public procedures). Standalone, saving files the lead. */}
      {savedNumber ? (
        <div className="flex flex-col gap-3">
          <Notice tone="info" title={`Saved — reference ${savedNumber}`}>
            We&rsquo;ve got your estimate and will be in touch to schedule.
          </Notice>
        </div>
      ) : (
        <div>
          {showForm ? (
            <Card>
              <CardBody className="flex flex-col gap-3">
                {error ? <Notice tone="warn">{error}</Notice> : null}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
                  <Field label="Email"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
                  <Field label="Phone"><Input value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
                  <Field label="Job address"><Input value={address} onChange={(e) => setAddress(e.target.value)} /></Field>
                </div>
                <div className="flex gap-2">
                  <Button variant="primary" disabled={submit.isPending} onClick={() => void save()}>
                    {submit.isPending ? "Saving…" : "Send my estimate"}
                  </Button>
                  <Button onClick={() => setShowForm(false)}>Cancel</Button>
                </div>
              </CardBody>
            </Card>
          ) : (
            <Button variant="primary" onClick={() => setShowForm(true)}>
              {product?.isEstimatable ? "Save this estimate & get a call" : "Request a quote"}
            </Button>
          )}
        </div>
      )}

      {!compact ? (
        <p className="text-xs text-ink-faint">
          Powered by <span className="font-mono">__SCOPE__/estimator</span>.
        </p>
      ) : null}
    </div>
  );
}

/** The estimator's live demo for the marketing feature page. */
export function EstimatorFeatureDemo() {
  return <EstimateTool compact />;
}

function Field({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium uppercase tracking-wider text-ink-faint">
      {label}
      {children}
    </label>
  );
}
