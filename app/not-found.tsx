// SPEC §6 Route table, 404: the siblings' page with "brief" changed to "edition". Also what an unknown
// /brief/<date> or /items/<id> renders (dynamicParams false).
import Link from "next/link";
import { PageHeader } from "@/components/layout/chrome";

export default function NotFound() {
  return (
    <>
      <PageHeader title="Not found" />
      <p className="text-[15px]">There is no page here. The <Link href="/archive">archive</Link> lists every edition.</p>
    </>
  );
}
