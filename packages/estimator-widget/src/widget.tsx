import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { EstimatorTransport } from "./transport.js";
import { injectStyles } from "./styles.js";
import type { EmbedMeasurement, EmbedOption, EmbedProduct, EstimatorConfig } from "./types.js";

interface EstimatorContextValue {
  transport: EstimatorTransport;
  config: EstimatorConfig;
  open: boolean;
  setOpen: (open: boolean) => void;
}

const EstimatorContext = createContext<EstimatorContextValue | null>(null);

export function useEstimator(): EstimatorContextValue {
  const ctx = useContext(EstimatorContext);
  if (!ctx) throw new Error("useEstimator must be used inside <EstimatorProvider>");
  return ctx;
}

export function EstimatorProvider({
  config,
  children,
}: {
  config: EstimatorConfig;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const transport = useMemo(
    () => new EstimatorTransport(config.baseUrl, config.clientKey),
    [config.baseUrl, config.clientKey],
  );
  useEffect(() => {
    injectStyles();
  }, []);
  return (
    <EstimatorContext.Provider value={{ transport, config, open, setOpen }}>
      {children}
    </EstimatorContext.Provider>
  );
}

export function EstimatorButton({ label = "Get an instant estimate" }: { label?: string }) {
  const { setOpen } = useEstimator();
  return (
    <button type="button" className="aie-fab" onClick={() => setOpen(true)}>
      {label}
    </button>
  );
}

function usd(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

export function EstimatorModal() {
  const { transport, config, open, setOpen } = useEstimator();
  const [products, setProducts] = useState<EmbedProduct[]>([]);
  const [productId, setProductId] = useState("");
  const product = products.find((p) => p.id === productId) ?? null;
  const mode = product?.measurementMode ?? "area";

  const [widthIn, setWidthIn] = useState("36");
  const [heightIn, setHeightIn] = useState("30");
  const [linearFt, setLinearFt] = useState("20");
  const [quantity, setQuantity] = useState("1");
  const [options, setOptions] = useState<EmbedOption[]>([]);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [low, setLow] = useState<number | null>(null);
  const [high, setHigh] = useState<number | null>(null);

  const [takeoffBusy, setTakeoffBusy] = useState(false);
  const [takeoffMsg, setTakeoffMsg] = useState<string | null>(null);
  const [takeoffSummary, setTakeoffSummary] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedNumber, setSavedNumber] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    void transport.config().then((list) => {
      setProducts(list);
      if (list.length > 0) setProductId((list.find((p) => p.isEstimatable) ?? list[0]!).id);
    });
  }, [open, transport]);

  useEffect(() => {
    if (!productId || !product?.isEstimatable) {
      setOptions([]);
      return;
    }
    setTakeoffSummary(null);
    setTakeoffMsg(null);
    void transport.options(productId).then((opts) => {
      setOptions(opts);
      setChoices((prev) => {
        const next = { ...prev };
        for (const o of opts) {
          if (!next[o.id]) {
            const def = o.values.find((v) => v.isDefault) ?? o.values[0];
            if (def) next[o.id] = def.id;
          }
        }
        return next;
      });
    });
  }, [productId, product, transport]);

  const qty = Math.max(1, Number(quantity) || 1);
  const measurement: EmbedMeasurement =
    mode === "linear"
      ? { linearFt: Number(linearFt) || 0 }
      : mode === "unit"
        ? { units: qty }
        : { widthIn: Number(widthIn) || 0, heightIn: Number(heightIn) || 0 };
  const valid =
    mode === "linear"
      ? (Number(linearFt) || 0) > 0
      : mode === "unit"
        ? qty > 0
        : (Number(widthIn) || 0) > 0 && (Number(heightIn) || 0) > 0;

  const measureKey = JSON.stringify({ measurement, qty, choices, productId });
  useEffect(() => {
    if (!productId || !product?.isEstimatable || !valid) {
      setLow(null);
      setHigh(null);
      return;
    }
    const id = setTimeout(() => {
      void transport
        .calculate({ productId, measurement, quantity: qty, optionValueIds: Object.values(choices) })
        .then((r) => {
          setLow(r ? r.estimateLow : null);
          setHigh(r ? r.estimateHigh : null);
        });
    }, 300);
    return () => clearTimeout(id);
    // measureKey captures the inputs that change the price.

  }, [measureKey, product, valid, productId, transport]);

  const onPhoto = async (file: File) => {
    setTakeoffMsg(null);
    setTakeoffSummary(null);
    if (!product) return;
    if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.type)) {
      setTakeoffMsg("Please use a JPEG, PNG, WEBP, or GIF photo.");
      return;
    }
    if (file.size > 5_000_000) {
      setTakeoffMsg("That image is a bit large — use one under 5 MB.");
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
      const out = await transport.takeoff({
        productId: product.id,
        imageBase64: dataUrl.split(",")[1] ?? "",
        mediaType: file.type,
      });
      if (!out.available) {
        setTakeoffMsg("Photo estimates aren't enabled here — enter the measurement by hand.");
        return;
      }
      const r = out.result;
      if (!r) {
        setTakeoffMsg("Couldn't read a measurement from that photo — enter it by hand.");
        return;
      }
      setTakeoffSummary(`${r.summary} (${r.confidence} confidence)`);
      if (mode === "linear" && r.linearFt) setLinearFt(String(Math.round(r.linearFt)));
      else if (mode === "unit" && r.units) setQuantity(String(Math.max(1, Math.round(r.units))));
      else if (mode === "area" && r.sqFt) {
        const side = Math.max(1, Math.round(Math.sqrt(r.sqFt) * 12));
        setWidthIn(String(side));
        setHeightIn(String(side));
      }
    } catch {
      setTakeoffMsg("Couldn't read that photo — enter the measurement by hand.");
    } finally {
      setTakeoffBusy(false);
    }
  };

  const save = async () => {
    if (!product) return;
    setSaving(true);
    try {
      const result = await transport.submit({
        customerName: name.trim() || null,
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
            optionValueIds: Object.values(choices),
          },
        ],
      });
      if (result) setSavedNumber(result.estimateNumber);
      else setTakeoffMsg("Something went wrong saving that. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className="aie-root aie-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) setOpen(false);
      }}
    >
      <div className="aie-modal" role="dialog" aria-modal="true">
        <div className="aie-head">
          <div>
            <div className="aie-title">{config.title ?? "Instant estimate"}</div>
            <div className="aie-sub">{config.subtitle ?? "A real ballpark in seconds — before anyone drives out."}</div>
          </div>
          <button type="button" className="aie-close" aria-label="Close" onClick={() => setOpen(false)}>
            ×
          </button>
        </div>

        <div className="aie-body">
          {products.length === 0 ? (
            <p className="aie-note">Loading…</p>
          ) : (
            <>
              <div>
                <span className="aie-label">What do you need?</span>
                <div className="aie-chips">
                  {products.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className={`aie-chip${p.id === productId ? " aie-on" : ""}`}
                      onClick={() => {
                        setProductId(p.id);
                        setSavedNumber(null);
                        setShowForm(false);
                      }}
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
                {product?.description ? <p className="aie-note" style={{ marginTop: 8 }}>{product.description}</p> : null}
              </div>

              {product && !product.isEstimatable ? (
                <p className="aie-note">This one needs a quick look to price fairly — leave your details and we&rsquo;ll reach out.</p>
              ) : null}

              {product?.isEstimatable ? (
                <div className="aie-drop">
                  <span className="aie-label">Estimate from a photo</span>
                  <input
                    type="file"
                    accept="image/*"
                    disabled={takeoffBusy}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void onPhoto(f);
                    }}
                  />
                  {takeoffBusy ? <p className="aie-note" style={{ marginTop: 6 }}>Reading your photo…</p> : null}
                  {takeoffMsg ? <p className="aie-note" style={{ marginTop: 6 }}>{takeoffMsg}</p> : null}
                  {takeoffSummary ? <div className="aie-detail" style={{ marginTop: 6 }}>{takeoffSummary}</div> : null}
                </div>
              ) : null}

              {product?.isEstimatable ? (
                <div className="aie-fields">
                  {mode === "area" ? (
                    <>
                      <label className="aie-field"><span className="aie-label">Width (in)</span><input className="aie-input" style={{ width: 90 }} type="number" min="0" value={widthIn} onChange={(e) => setWidthIn(e.target.value)} /></label>
                      <label className="aie-field"><span className="aie-label">Height (in)</span><input className="aie-input" style={{ width: 90 }} type="number" min="0" value={heightIn} onChange={(e) => setHeightIn(e.target.value)} /></label>
                    </>
                  ) : mode === "linear" ? (
                    <label className="aie-field"><span className="aie-label">Length of run (ft)</span><input className="aie-input" style={{ width: 120 }} type="number" min="0" value={linearFt} onChange={(e) => setLinearFt(e.target.value)} /></label>
                  ) : null}
                  <label className="aie-field"><span className="aie-label">How many</span><input className="aie-input" style={{ width: 80 }} type="number" min="1" value={quantity} onChange={(e) => setQuantity(e.target.value)} /></label>
                </div>
              ) : null}

              {product?.isEstimatable
                ? options.map((o) => (
                    <div key={o.id}>
                      <span className="aie-label">{o.name}</span>
                      <div className="aie-chips">
                        {o.values.map((v) => (
                          <button
                            key={v.id}
                            type="button"
                            className={`aie-chip${choices[o.id] === v.id ? " aie-on" : ""}`}
                            onClick={() => setChoices((c) => ({ ...c, [o.id]: v.id }))}
                          >
                            {v.label}
                            {v.priceModifier > 0 ? ` +${usd(v.priceModifier)}` : ""}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))
                : null}

              {product?.isEstimatable ? (
                <div className="aie-range">
                  <span className="aie-label">Estimated ballpark</span>
                  {low !== null && high !== null ? (
                    <div className="aie-range-n">
                      {usd(low)} – {usd(high)}
                    </div>
                  ) : (
                    <p className="aie-note">Enter a measurement to see a range.</p>
                  )}
                  <p className="aie-note" style={{ marginTop: 4 }}>Final pricing is confirmed on a site visit.</p>
                </div>
              ) : null}

              {savedNumber ? (
                <div className="aie-ok">Saved — reference {savedNumber}. We&rsquo;ll be in touch to confirm.</div>
              ) : showForm ? (
                <div className="aie-fields" style={{ flexDirection: "column", alignItems: "stretch" }}>
                  <input className="aie-input" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
                  <input className="aie-input" placeholder="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
                  <input className="aie-input" placeholder="Phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
                  <input className="aie-input" placeholder="Job address" value={address} onChange={(e) => setAddress(e.target.value)} />
                  <div style={{ display: "flex", gap: 8 }}>
                    <button type="button" className="aie-btn" disabled={saving} onClick={() => void save()}>
                      {saving ? "Saving…" : "Send my estimate"}
                    </button>
                    <button type="button" className="aie-btn aie-btn-ghost" onClick={() => setShowForm(false)}>Cancel</button>
                  </div>
                </div>
              ) : (
                <button type="button" className="aie-btn" onClick={() => setShowForm(true)}>
                  {product?.isEstimatable ? "Save this estimate & get a call" : "Request a quote"}
                </button>
              )}
            </>
          )}
        </div>
        <div className="aie-powered">Powered by adminigloo</div>
      </div>
    </div>
  );
}
