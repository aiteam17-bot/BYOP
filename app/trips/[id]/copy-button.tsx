"use client";

import { useState } from "react";
import { secondaryButton } from "@/components/ui";

export function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked: the link is also selectable in the box beside this.
    }
  }

  return (
    <button type="button" onClick={copy} className={secondaryButton}>
      {copied ? "Copied!" : "Copy link"}
    </button>
  );
}
