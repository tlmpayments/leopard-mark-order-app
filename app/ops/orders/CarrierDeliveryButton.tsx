"use client";

import { useActionState } from "react";
import { markCarrierDeliveredAction } from "./carrier-actions";

export function CarrierDeliveryButton({ orderId, day, problem }: { orderId: string; day: string | null; problem: string | null }) {
  const [state, action, pending] = useActionState(markCarrierDeliveredAction, {});
  if (state.success) return <span className="pill good" role="status">Delivered · sheet update queued</span>;
  return <form action={action} style={{ marginTop: 8 }}>
    <input type="hidden" name="orderId" value={orderId} />
    <button className="btn primary" type="submit" disabled={pending || !!problem}>
      {pending ? "Saving…" : "Mark delivered"}
    </button>
    <div className="small muted">{problem || `Carrier delivery · ${day}`}</div>
    {state.error && <p className="small" role="alert">{state.error}</p>}
  </form>;
}
