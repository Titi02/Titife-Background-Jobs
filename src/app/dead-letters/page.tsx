import Link from "next/link";
import DeadLetterQueue from "@/components/DeadLetterQueue";

export default function DeadLettersPage() {
  return (
    <div>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link href="/jobs">Jobs</Link>
        <span className="separator" aria-hidden="true">
          /
        </span>
        <span className="current" aria-current="page">
          Dead Letter Queue
        </span>
        <span className="separator" aria-hidden="true">|</span>
        <Link href="/create">Send Email</Link>
      </nav>
      <DeadLetterQueue />
    </div>
  );
}
