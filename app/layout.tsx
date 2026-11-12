// The page frame (SPEC §7 "Page frame"): the siblings' layout with CyberTracker's fonts, metadata, paper
// theme colour and column. Owner: P4 foundation (S0); the pages lane fills the Masthead, Footer and banners it renders.
import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans, Newsreader } from "next/font/google";
import type { ReactNode } from "react";
import { Footer } from "@/components/layout/Footer";
import { Masthead } from "@/components/layout/Masthead";
import { SampleBanner } from "@/components/layout/SampleBanner";
import { SITE_NAME, SITE_TAGLINE, THEME_COLOR, contentDir, isSampleData, siteUrl } from "@/lib/site";
import "./globals.css";

const newsreader = Newsreader({ subsets: ["latin"], style: ["normal", "italic"], axes: ["opsz"], variable: "--font-newsreader", display: "swap" });
const plexSans = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-plex-sans", display: "swap" });
const plexMono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-plex-mono", display: "swap" });

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: { default: `${SITE_NAME}: ${SITE_TAGLINE}`, template: `%s · ${SITE_NAME}` },
  description: SITE_TAGLINE,
  alternates: { types: { "application/rss+xml": [{ url: "/feed.xml", title: `${SITE_NAME} daily brief` }] } },
  // Sample mode (§6): the banner and noindex always together.
  robots: isSampleData() ? { index: false, follow: false } : undefined,
};

export const viewport: Viewport = {
  themeColor: THEME_COLOR,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  const sample = isSampleData();
  return (
    <html lang="en" className={`${newsreader.variable} ${plexSans.variable} ${plexMono.variable}`}>
      <body>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:bg-fg focus:px-3 focus:py-2 focus:font-mono focus:text-[12px] focus:text-bg"
        >
          Skip to the brief
        </a>
        {sample ? <SampleBanner dir={contentDir()} /> : null}
        <div className="mx-auto w-full max-w-[768px] px-4 pt-5 pb-10 sm:px-6">
          <Masthead />
          <main id="main" className="mt-6">{children}</main>
          <Footer />
        </div>
      </body>
    </html>
  );
}
