import type { Metadata } from "next";
import { CallToAction } from "@/components/marketing/CallToAction";
import { Faq } from "@/components/marketing/Faq";
import { Hero } from "@/components/marketing/Hero";
import { HowItWorks } from "@/components/marketing/HowItWorks";
import { Outcomes } from "@/components/marketing/Outcomes";
import { PlansTeaser } from "@/components/marketing/PlansTeaser";
import { isSignedIn } from "@/components/marketing/viewer";

/**
 * The landing page, for business owners (create-app 0.36): what it does for
 * them, three outcomes, how it works in three steps, the plans, and the
 * questions they ask before signing up.
 *
 * THE RUNNING ORDER AND NOTHING ELSE. Every word is in src/marketing-copy.ts
 * — the one file a project edits to speak its trade — and each section is its
 * own file, so reordering the page is moving a line and dropping a section is
 * deleting one. Product screenshots appear by themselves once they're saved
 * in public/screenshots/ (SCREENSHOTS in src/marketing-copy.ts names them).
 *
 * WHERE THE ORIENTATION PAGE WENT. In a project generated without a marketing
 * site, `/` is the developer's file map. This page takes `/` instead, and the
 * generator writes that one to `/setup/start`, beside the other developer
 * surface.
 *
 * Someone already signed in is offered "Go to your dashboard", not "Get
 * started" — the header's sign-in check, asked once more here.
 */
export const metadata: Metadata = {
  // Its own canonical, set here rather than inherited. Metadata merges field by
  // field down the tree, so a canonical in the root layout would be adopted by
  // every page that did not override it — a whole site claiming to be `/`.
  alternates: { canonical: "/" },
};

export default async function Home() {
  const signedIn = await isSignedIn();
  return (
    <>
      <Hero signedIn={signedIn} />
      <Outcomes />
      <HowItWorks />
      <PlansTeaser />
      <Faq />
      <CallToAction signedIn={signedIn} />
    </>
  );
}
