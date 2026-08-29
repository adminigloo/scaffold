import Link from "next/link";
import { HealthCheck } from "@/components/HealthCheck";

export default function Home() {
  return (
    <main style={{ fontFamily: "system-ui", padding: "3rem", lineHeight: 1.6 }}>
      <h1>__PROJECT_NAME__</h1>
      <p>
        Auth, tenancy, permissions, tRPC and the environment contract are wired.
        Start building features.
      </p>
      <p style={{ color: "#4b5563" }}>
        <HealthCheck />
      </p>
      <p style={{ color: "#4b5563" }}>
        <Link href="/setup">What is configured, and what is not</Link> &mdash; add
        credentials to <code>.env.local</code> whenever you want the feature they
        unlock. Nothing here blocks you from building.
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
        <li>
          Call it from a client component: <code>src/trpc/client.tsx</code>
        </li>
        <li>
          Call it from a server component: <code>src/trpc/server.ts</code>
        </li>
      </ul>
    </main>
  );
}
