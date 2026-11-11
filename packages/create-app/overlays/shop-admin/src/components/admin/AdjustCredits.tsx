"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, CardBody, CardHeader, Field, Input, Notice } from "@/components/ui";
import { api } from "@/trpc/client";

/**
 * Add or take away credits by hand. A note is required (the server refuses an
 * empty one), and one attempt id per opening of the form makes a double click
 * adjust once: the wallet keys the movement on it.
 */
export function AdjustCredits({
  holderId,
  holderLabel,
  units,
  unit,
}: {
  readonly holderId: string;
  readonly holderLabel: string | null;
  readonly units: readonly string[];
  readonly unit: string;
}) {
  const router = useRouter();
  const adjust = api.credits.adjust.useMutation();
  const [holder, setHolder] = useState(holderId);
  const [chosenUnit, setChosenUnit] = useState(unit);
  const [delta, setDelta] = useState("");
  const [note, setNote] = useState("");
  const [done, setDone] = useState<string | null>(null);
  // A fresh id each time the form is used for a new adjustment.
  const [attempt, setAttempt] = useState(() => crypto.randomUUID());
  const amount = useMemo(() => Number.parseInt(delta, 10), [delta]);
  const valid = holder.trim() !== "" && /^[a-z][a-z0-9-]{0,31}$/.test(chosenUnit) && Number.isInteger(amount) && amount !== 0 && note.trim().length >= 3;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!valid) return;
    setDone(null);
    try {
      const result = await adjust.mutateAsync({ holderId: holder.trim(), unit: chosenUnit, delta: amount, note: note.trim(), attempt });
      setDone(result.applied ? `Done. Their balance is now ${result.balance} ${chosenUnit}.` : "That adjustment was already made.");
      setDelta("");
      setNote("");
      setAttempt(crypto.randomUUID());
      router.refresh();
    } catch {
      // The mutation's error is shown below from `adjust.error`.
    }
  }

  return (
    <Card>
      <CardHeader
        title="Adjust a balance"
        hint="Positive adds, negative takes away. Never below zero. Every adjustment is a sensitive audit row."
      />
      <CardBody>
        <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
          <Field label="Who (holder id)" htmlFor="adjust-holder" hint={holderLabel ?? "Pick someone from the balances above, or paste their id."}>
            <Input id="adjust-holder" value={holder} onChange={(e) => setHolder(e.target.value)} autoComplete="off" />
          </Field>
          <Field label="Unit" htmlFor="adjust-unit" hint="A lower-case slug, as the product's grant names it.">
            <Input id="adjust-unit" value={chosenUnit} onChange={(e) => setChosenUnit(e.target.value.trim())} list="adjust-units" autoComplete="off" />
            <datalist id="adjust-units">
              {units.map((u) => (
                <option key={u} value={u} />
              ))}
            </datalist>
          </Field>
          <Field label="Change" htmlFor="adjust-delta" hint="e.g. 10, or -3">
            <Input id="adjust-delta" value={delta} onChange={(e) => setDelta(e.target.value)} inputMode="numeric" />
          </Field>
          <Field label="Why" htmlFor="adjust-note" hint="Required. Shown in the ledger and the audit log.">
            <Input id="adjust-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
          </Field>
          <div className="sm:col-span-2 flex flex-wrap items-center gap-3">
            <Button type="submit" variant="primary" disabled={!valid || adjust.isPending}>
              {adjust.isPending ? "Adjusting…" : "Adjust"}
            </Button>
            {done ? <p className="text-sm text-ink-muted">{done}</p> : null}
          </div>
          {adjust.error ? (
            <div className="sm:col-span-2">
              <Notice tone="danger">{adjust.error.message}</Notice>
            </div>
          ) : null}
        </form>
      </CardBody>
    </Card>
  );
}
