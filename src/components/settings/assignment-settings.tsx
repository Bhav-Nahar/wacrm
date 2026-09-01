"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Shuffle } from "lucide-react";
import { useTranslations } from "next-intl";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import type { AccountRole } from "@/lib/auth/roles";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { SettingsPanelHead } from "./settings-panel-head";

/**
 * Account-wide auto-assignment defaults.
 *
 * These settings only ever lived inside an individual automation's
 * "Assign conversation" step — three levels into the builder — so the
 * question "how does work get shared out across my team?" had no answer
 * anywhere an operator would look. This is that answer, once, for the
 * account; a step that sets its own values still overrides it.
 *
 * Writes go to `accounts` (migration 041), whose `accounts_update` RLS
 * policy already restricts writes to admins+, so non-admins get a
 * read-only view rather than a control that fails on save.
 */

/** Roles that can hold a conversation. `viewer` cannot reply, so it is absent. */
const ROLE_OPTIONS: AccountRole[] = ["owner", "admin", "agent"];

export function AssignmentSettings() {
  const supabase = createClient();
  const { accountId, canEditSettings, profileLoading } = useAuth();
  const t = useTranslations("Settings.assignment");

  const [roles, setRoles] = useState<AccountRole[]>(ROLE_OPTIONS);
  const [onlineOnly, setOnlineOnly] = useState(false);
  const [saved, setSaved] = useState<{
    roles: AccountRole[];
    onlineOnly: boolean;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!accountId) return;
    const { data } = await supabase
      .from("accounts")
      .select("default_assignment_roles, default_assignment_online_only")
      .eq("id", accountId)
      .maybeSingle();

    // NULL means "never configured", and the engine's own default applies —
    // so show that default ticked rather than an empty, misleading form.
    const nextRoles = (data?.default_assignment_roles as AccountRole[] | null)
      ?.length
      ? (data!.default_assignment_roles as AccountRole[])
      : ROLE_OPTIONS;
    const nextOnline = Boolean(data?.default_assignment_online_only);

    setRoles(nextRoles);
    setOnlineOnly(nextOnline);
    setSaved({ roles: nextRoles, onlineOnly: nextOnline });
    setLoading(false);
  }, [accountId, supabase]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const dirty =
    !!saved &&
    (saved.onlineOnly !== onlineOnly ||
      saved.roles.length !== roles.length ||
      !saved.roles.every((r) => roles.includes(r)));

  function toggleRole(role: AccountRole) {
    setRoles((prev) =>
      prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role],
    );
  }

  async function handleSave() {
    if (!accountId || !dirty) return;
    setSaving(true);
    const { error } = await supabase
      .from("accounts")
      .update({
        // Store NULL, not [], when nothing is ticked: an empty array would
        // read as "assign to nobody", and silently disabling assignment is
        // never what clearing a checkbox is meant to express.
        default_assignment_roles: roles.length > 0 ? roles : null,
        default_assignment_online_only: onlineOnly,
      })
      .eq("id", accountId);

    setSaving(false);
    if (error) {
      toast.error(t("saveFailed"));
      return;
    }
    setSaved({ roles, onlineOnly });
    toast.success(t("saveSuccess"));
  }

  const disabled = !canEditSettings || profileLoading || loading;

  return (
    <section className="max-w-2xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead title={t("title")} description={t("description")} />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <Shuffle className="size-4 text-primary" />
            {t("roundRobinTitle")}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {t("roundRobinDesc")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-2">
            <Label className="text-muted-foreground">{t("rolesLabel")}</Label>
            <div className="space-y-2">
              {ROLE_OPTIONS.map((role) => (
                <label
                  key={role}
                  className="flex items-center gap-2.5 text-sm text-foreground"
                >
                  <Checkbox
                    checked={roles.includes(role)}
                    onCheckedChange={() => toggleRole(role)}
                    disabled={disabled}
                    aria-label={t(`roles.${role}`)}
                  />
                  {t(`roles.${role}`)}
                </label>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">{t("rolesHint")}</p>
          </div>

          <div className="grid gap-2">
            <Label className="text-muted-foreground">
              {t("availabilityLabel")}
            </Label>
            <div className="flex items-center gap-2.5">
              <Switch
                checked={onlineOnly}
                onCheckedChange={setOnlineOnly}
                disabled={disabled}
                aria-label={t("onlineOnly")}
              />
              <span className="text-sm text-foreground">{t("onlineOnly")}</span>
            </div>
            <p className="text-xs text-muted-foreground">
              {t("onlineOnlyHint")}
            </p>
          </div>

          <p className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
            {t("overrideNote")}
          </p>

          {!canEditSettings ? (
            <p className="text-xs text-muted-foreground">{t("adminOnlyHint")}</p>
          ) : (
            <Button
              onClick={handleSave}
              disabled={saving || !dirty}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {saving ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t("saving")}
                </>
              ) : (
                t("save")
              )}
            </Button>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
