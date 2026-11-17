"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { CHANNEL_LABELS, MESSAGE_CHANNELS, type MessageChannel, type MessagingSettings } from "@lfm/shared";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { Toggle } from "@/components/ui/toggle";
import { useSubmit } from "@/lib/use-submit";

export function MessagingSettingsForm({ canEdit, initial }: { canEdit: boolean; initial: MessagingSettings }) {
  const router = useRouter();
  const [autoSend, setAutoSend] = useState(initial.autoSend);
  const [ackEnabled, setAckEnabled] = useState(initial.acknowledgement.enabled);
  const [ackChannels, setAckChannels] = useState<MessageChannel[]>(initial.acknowledgement.channels);
  const [fuEnabled, setFuEnabled] = useState(initial.followUpMessages.enabled);
  const [hours, setHours] = useState(initial.sendingHours.mode === "CUSTOM" ? "WORKING_HOURS" : initial.sendingHours.mode);
  const [fallback, setFallback] = useState<MessageChannel | "">(initial.fallbackChannel ?? "");
  const [vars, setVars] = useState<[string, string][]>(Object.entries(initial.customVariables));
  const { submit, loading, error, fields, success } = useSubmit();

  const toggleChannel = (c: MessageChannel) =>
    setAckChannels((cs) => (cs.includes(c) ? cs.filter((x) => x !== c) : [...cs, c]));

  async function save() {
    const ok = await submit(
      "/api/automation/config",
      {
        method: "PATCH",
        body: {
          autoSend,
          acknowledgementEnabled: ackEnabled,
          acknowledgementChannels: ackChannels,
          followUpMessagesEnabled: fuEnabled,
          sendingHoursMode: hours,
          fallbackChannel: fallback || null,
          customVariables: Object.fromEntries(vars.filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), v])),
        },
      },
      "Message settings saved.",
    );
    if (ok) router.refresh();
  }

  const varError = Object.entries(fields).find(([k]) => k.startsWith("customVariables"))?.[1];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Messages to customers</CardTitle>
        <CardDescription>What is sent automatically, on which channel, and when.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <fieldset disabled={!canEdit} className="space-y-6">
          <Toggle
            id="autosend"
            label="Send approved messages automatically"
            description="No one needs to press send for each message. Only approved templates are used, and only after you turn the automation on."
            checked={autoSend}
            onChange={setAutoSend}
            disabled={!canEdit}
          />
          <div className="space-y-2">
            <Toggle id="ack" label="Acknowledge every new inquiry" checked={ackEnabled} onChange={setAckEnabled} disabled={!canEdit} />
            {ackEnabled && (
              <div className="flex flex-wrap gap-4 pl-1 text-sm">
                {MESSAGE_CHANNELS.map((c) => (
                  <label key={c} className="flex items-center gap-2">
                    <input type="checkbox" className="size-4 accent-primary" checked={ackChannels.includes(c)} onChange={() => toggleChannel(c)} />
                    {CHANNEL_LABELS[c]}
                  </label>
                ))}
                <span className="text-muted-foreground">WhatsApp is only used for customers who opted in.</span>
              </div>
            )}
          </div>
          <Toggle
            id="fu"
            label="Send follow-up messages when a follow-up is due"
            description="Choose the channel for each step on the Follow-up schedule tab. Paused as soon as the customer replies."
            checked={fuEnabled}
            onChange={setFuEnabled}
            disabled={!canEdit}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="hours" label="Send automatic messages">
              <Select id="hours" value={hours} onChange={(e) => setHours(e.target.value as typeof hours)}>
                <option value="WORKING_HOURS">Only during working hours</option>
                <option value="ALWAYS">At any time</option>
              </Select>
            </Field>
            <Field id="fallback" label="If a channel can't be used" hint="e.g. no WhatsApp opt-in, or the message failed.">
              <Select id="fallback" value={fallback} onChange={(e) => setFallback(e.target.value as MessageChannel | "")}>
                <option value="">Don't try another channel</option>
                {MESSAGE_CHANNELS.map((c) => (
                  <option key={c} value={c}>
                    Try {CHANNEL_LABELS[c].toLowerCase()} instead
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium">Your own details for templates</p>
            <p className="text-sm text-muted-foreground">e.g. office_address → “12 MG Road, Bengaluru”, then use {"{{office_address}}"} in a template.</p>
            {vars.map(([k, v], i) => (
              <div key={i} className="flex flex-wrap gap-2">
                <Input aria-label="Name" value={k} placeholder="office_address" onChange={(e) => setVars((vs) => vs.map((x, j) => (j === i ? [e.target.value, x[1]] : x)))} className="w-48 font-mono" />
                <Input aria-label="Value" value={v} onChange={(e) => setVars((vs) => vs.map((x, j) => (j === i ? [x[0], e.target.value] : x)))} className="min-w-0 flex-1" />
                <Button type="button" variant="ghost" size="sm" aria-label="Remove" onClick={() => setVars((vs) => vs.filter((_, j) => j !== i))}>
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              </div>
            ))}
            {varError && <p className="text-sm text-destructive">{varError}</p>}
            {canEdit && (
              <Button type="button" variant="secondary" size="sm" onClick={() => setVars((vs) => [...vs, ["", ""]])}>
                <Plus className="size-4" aria-hidden /> Add detail
              </Button>
            )}
          </div>
        </fieldset>
        {error && <Alert tone="error">{error}</Alert>}
        {success && <Alert tone="success">{success}</Alert>}
        {canEdit && (
          <div className="flex justify-end">
            <Button onClick={save} loading={loading}>
              Save message settings
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
