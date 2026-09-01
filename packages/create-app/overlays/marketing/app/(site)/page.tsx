import type { Metadata } from "next";
import { CallToAction } from "@/components/marketing/CallToAction";
import { Faq } from "@/components/marketing/Faq";
import { Features } from "@/components/marketing/Features";
import { Hero } from "@/components/marketing/Hero";
import { SocialProof } from "@/components/marketing/SocialProof";

/**
 * The landing page.
 *
 * FIVE IMPORTS AND NOTHING ELSE, deliberately. Every client rewrites the copy
 * and about half of them delete two of these sections outright, so the page is
 * the running order and nothing more — reordering it is moving a line, and
 * dropping the social proof is deleting one. A single file with all five
 * sections inlined would make both of those a merge conflict with whatever the
 * scaffold ships next.
 *
 * WHERE THE ORIENTATION PAGE WENT. In a project generated without a marketing
 * site, `/` is the developer's file map — the health check and the list of
 * files to start editing. This page takes `/` instead, and the generator writes
 * that one to `/setup/start`, beside the other developer surface. It is in
 * `FOOTER_LINKS`, so it is still one click away from everywhere.
 *
 * STATIC. Nothing here reads a session, a database or a request, so the whole
 * page is rendered once at build and served from the edge — which is what a
 * landing page should be, and what the pricing page deliberately is not.
 *
 * It renders no header or footer of its own: `app/(site)/layout.tsx` mounts
 * both, so this page inherits the same chrome as every other public route.
 */
export const metadata: Metadata = {
  // Its own canonical, set here rather than inherited. Metadata merges field by
  // field down the tree, so a canonical in the root layout would be adopted by
  // every page that did not override it — a whole site claiming to be `/`.
  alternates: { canonical: "/" },
};

export default function Home() {
  return (
    <>
      <Hero />
      <Features />
      <SocialProof />
      <Faq />
      <CallToAction />
    </>
  );
}
