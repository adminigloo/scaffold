export default function Home() {
  return (
    <main style={{ fontFamily: "system-ui", padding: "3rem", lineHeight: 1.6 }}>
      <h1>__PROJECT_NAME__</h1>
      <p>
        Auth, tenancy, permissions, tRPC and the environment contract are wired.
        Start building features.
      </p>
      <ul>
        <li>
          Permission keys: <code>src/permissions/catalog.ts</code>
        </li>
        <li>
          Your tables: <code>src/db/schema.ts</code>
        </li>
        <li>
          Your API: <code>src/server/routers/_app.ts</code>
        </li>
      </ul>
    </main>
  );
}
