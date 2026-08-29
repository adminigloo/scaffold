export default function ErrorsPage() {
  return (
    <>
      <h1 style={{ fontSize: "1.5rem", margin: "0 0 1rem" }}>Errors</h1>
      <p style={{ color: "#6b7280", maxWidth: "60ch" }}>
        Backed by <code>error_log</code> in <code>__SCOPE__/observability</code>.
        Repeated errors increment an occurrence count against a stable
        fingerprint rather than inserting a new row, so this list stays readable
        under a real incident.
      </p>
    </>
  );
}
