"use client";

import { useState } from "react";

// A fresh idempotency key for one form submission. If the same request is
// sent twice (double tap, network retry), the database adds one row. The form
// remounts after each success, which makes a new key for the next one.
export function ClientKey() {
  const [key] = useState(() => crypto.randomUUID());
  return <input type="hidden" name="client_key" value={key} readOnly suppressHydrationWarning />;
}
