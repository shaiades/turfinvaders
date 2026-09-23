// §19.3 — the individual rep profile: header, Sections A–F, safety flags,
// and reflections the rep chose to share. Private answers stay private —
// the leadership whys RPC already masks text, and this surface renders
// "Private to rep" plus any structured categories, never the words.
// Red appears ONLY on the safety-flag card.

import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/useAuth";
import {
  usePurposeLeadershipDetail,
  useResolveSafetyFlag,
} from "@/hooks/usePurposeLeadership";
import { usePurposeScoreboard } from "@/hooks/usePurposeScoreboard";
import type { PurposeWhyLeadershipRow } from "@/hooks/usePurposeTable";
import type { Option } from "@/lib/purpose/types";
import {
  BELIEF_CATEGORY_OPTIONS,
  CORE_VALUE_CHIPS,
  EMPTY_STATE_COPY,
  MODULES,
  OBSTACLE_OPTIONS,
  PERSONAL_FOCUS_OPTIONS,
  PERSONAL_GAP_OPTIONS,
  PRO_FOCUS_OPTIONS,
  STORY_ORIGIN_OPTIONS,
  SUPPORT_REQUEST_OPTIONS,
  WHY4_PRIVATE_CATEGORIES,
  WHY5_PRIVATE_CATEGORIES,
} from "@/data/purpose-workshop-content";
import { MODULE_KEYS } from "@/lib/purpose/questionKeys";
import { PurposeButton, PurposeCard, PurposeLabel } from "./kit";
import { PurposeLeadershipActions } from "./PurposeLeadershipActions";
import {
  completionOf,
  constraintLabel,
  fmtDate,
  fmtMoney,
  humanize,
  LEADERSHIP_STATUS_LABELS,
  optionLabel,
  PurposeStatusPill,
} from "./PurposeLeadership";

const fmtPct = (p: number | null) => (p == null ? "—" : `${Math.round(p * 100)}%`);

const moduleLabel = (key: string) => {
  const m = MODULES.find((mm) => mm.key === key || MODULE_KEYS[mm.key] === key);
  return m ? m.label : humanize(key);
};

function PrivateShort() {
  return <span className="italic text-[var(--purpose-ink-dim)]">Private to rep</span>;
}

function Dash() {
  return <span className="text-[var(--purpose-ink-dim)]">—</span>;
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <PurposeLabel>{label}</PurposeLabel>
      <div className="mt-1 whitespace-pre-line text-base leading-relaxed">{value || <Dash />}</div>
    </div>
  );
}

function Bullets({
  slugs,
  opts,
}: {
  slugs: string[] | null | undefined;
  opts: readonly Option[];
}) {
  if (!slugs || slugs.length === 0) return <Dash />;
  return (
    <ul className="space-y-1">
      {slugs.map((s) => (
        <li key={s}>{optionLabel(opts, s)}</li>
      ))}
    </ul>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-[var(--purpose-line)] p-3 text-center">
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      <div className="mt-0.5 text-[11px] uppercase tracking-wider text-[var(--purpose-ink-dim)]">
        {label}
      </div>
    </div>
  );
}

function SectionCard({
  section,
  title,
  children,
}: {
  section: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <PurposeCard className="mt-4">
      <PurposeLabel>Section {section}</PurposeLabel>
      <h2 className="mt-1 text-lg">{title}</h2>
      <div className="mt-4 space-y-4">{children}</div>
    </PurposeCard>
  );
}

/** Structured categories a why row carries even when its text is private. */
function whyCategoryLabels(w: PurposeWhyLeadershipRow | undefined): string | null {
  if (!w) return null;
  const opts =
    w.level_number === 4
      ? WHY4_PRIVATE_CATEGORIES
      : w.level_number === 5
        ? WHY5_PRIVATE_CATEGORIES
        : w.level_number === 6
          ? CORE_VALUE_CHIPS
          : [];
  const cats = w.answer_categories_json ?? (w.answer_category ? [w.answer_category] : []);
  if (cats.length === 0) return null;
  return cats.map((c) => optionLabel(opts, c)).join(", ");
}

const isPrivateWhy = (w: PurposeWhyLeadershipRow | undefined) =>
  !!w && w.answer_text == null && w.visibility === "private_to_rep";

export function PurposeRepProfile({ userId }: { userId: string }) {
  const { user } = useAuth();
  const detailQuery = usePurposeLeadershipDetail(userId);
  const detail = detailQuery.data;
  const resolveFlag = useResolveSafetyFlag();
  // Section E — the same real Close Kombat numbers the rep sees, matched by
  // display name. No commissions, no invented comparisons.
  const scoreboard = usePurposeScoreboard(detail?.displayName ?? null, !!detail?.profile);

  const profile = detail?.profile ?? null;
  const goals = detail?.goals ?? {};
  const beliefs = detail?.beliefs ?? null;
  const answers = detail?.answers ?? {};
  const why = (n: number) => detail?.whys.find((w) => w.level_number === n);

  const openFlags = (detail?.safetyFlags ?? []).filter((f) => !f.cleared_at);
  const sharedReflections = (detail?.reflections ?? []).filter(
    (r) => r.visibility === "leadership_shared",
  );

  const g3 = goals["possibility_3_year"];
  const g1 = goals["target_1_year"];
  const g90 = goals["mission_90_day"];
  const gPro = goals["professional_focus"];
  const gPersonal = goals["personal_focus"];
  const w5 = why(5);
  const w6 = why(6);
  const w7 = why(7);

  const obstaclesJson = answers["m5_obstacles"]?.answer_value_json;
  const obstacles = Array.isArray(obstaclesJson) ? (obstaclesJson as string[]) : [];
  const supportJson = (answers["m5_support_request"]?.answer_value_json ?? null) as {
    selections?: string[];
    context?: string;
  } | null;
  const supportSelections = Array.isArray(supportJson?.selections) ? supportJson!.selections : [];
  const identityCommitment = answers["m5_identity_commitment"]?.answer_value_text ?? null;
  const ifThen = detail?.ifThen ?? null;

  const week = scoreboard.week;

  return (
    <div className="purpose-surface min-h-dvh">
      <div className="mx-auto w-full min-w-0 max-w-3xl px-4 pt-safe pb-16">
        <div className="pt-5">
          <Link
            to="/purpose-leadership"
            className="inline-flex min-h-11 items-center gap-1.5 text-sm text-[var(--purpose-tide)] hover:underline"
          >
            <ArrowLeft className="size-4" aria-hidden />
            Purpose Leadership
          </Link>
        </div>

        {detailQuery.isLoading ? (
          <p className="mt-6 text-sm text-[var(--purpose-ink-dim)]">Loading…</p>
        ) : !detail ? (
          <p className="mt-6 text-sm text-[var(--purpose-ink-dim)]">
            Couldn't load this profile. Try again in a moment.
          </p>
        ) : !profile ? (
          <PurposeCard className="mt-4">
            <h1 className="text-xl">{detail.displayName}</h1>
            <p className="mt-2 text-sm leading-relaxed text-[var(--purpose-ink-dim)]">
              {detail.displayName} hasn't started their Purpose Profile yet. This page fills in
              as they walk the workshop.
            </p>
          </PurposeCard>
        ) : (
          <>
            {/* Safety flags — discreet, red, and never any answer text. */}
            {openFlags.length > 0 && (
              <div className="mt-4 rounded-2xl border border-red-500/70 bg-red-500/10 p-5">
                <PurposeLabel className="text-red-300">Safety flag</PurposeLabel>
                <div className="mt-2 space-y-3">
                  {openFlags.map((f) => (
                    <div
                      key={f.id}
                      className="flex flex-wrap items-center justify-between gap-3"
                    >
                      <p className="text-sm leading-relaxed text-red-200">
                        Fired {fmtDate(f.flagged_at)}
                        {f.module_key ? ` · ${moduleLabel(f.module_key)}` : ""}
                        {f.question_key ? ` · ${humanize(f.question_key)}` : ""}
                        {f.acknowledged_at ? " · acknowledged" : ""}
                      </p>
                      <div className="flex gap-2">
                        {!f.acknowledged_at && (
                          <PurposeButton
                            tone="ghost"
                            className="border-red-400/60 px-3 text-sm text-red-200"
                            disabled={resolveFlag.isPending || !user}
                            onClick={() =>
                              resolveFlag.mutate({
                                id: f.id,
                                action: "acknowledge",
                                byUserId: user!.id,
                              })
                            }
                          >
                            Acknowledge
                          </PurposeButton>
                        )}
                        <PurposeButton
                          tone="ghost"
                          className="border-red-400/60 px-3 text-sm text-red-200"
                          disabled={resolveFlag.isPending || !user}
                          onClick={() =>
                            resolveFlag.mutate({ id: f.id, action: "clear", byUserId: user!.id })
                          }
                        >
                          Clear
                        </PurposeButton>
                      </div>
                    </div>
                  ))}
                </div>
                <p className="mt-3 text-xs text-red-200/80">
                  Check in personally today. What they wrote stays with them.
                </p>
              </div>
            )}

            {/* Header */}
            <PurposeCard className="mt-4">
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="text-2xl">{detail.displayName}</h1>
                <PurposeStatusPill completion={completionOf(profile)} />
                {profile.leadership_status && (
                  <span className="text-xs uppercase tracking-wider text-[var(--purpose-ink-dim)]">
                    {LEADERSHIP_STATUS_LABELS[profile.leadership_status]}
                  </span>
                )}
              </div>
              <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1.5 text-sm text-[var(--purpose-ink-dim)]">
                <span>{profile.role === "owner" ? "Owner" : "Sales rep"}</span>
                {profile.completed_at && <span>Completed {fmtDate(profile.completed_at)}</span>}
                <span className="tabular-nums">
                  Follow-up {fmtDate(profile.leadership_follow_up_date)}
                </span>
                <span className="tabular-nums">
                  {profile.last_reviewed_at
                    ? `Last reviewed ${fmtDate(profile.last_reviewed_at)}`
                    : "Not reviewed yet"}
                </span>
              </div>
            </PurposeCard>

            {/* A — Direction */}
            <SectionCard section="A" title="Direction">
              <Field label="Three-year possibility" value={g3?.goal_description} />
              <Field label="One-year target" value={g1?.goal_description} />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Target date" value={g1?.target_date ? fmtDate(g1.target_date) : null} />
                <Field label="Measurable outcome" value={g1?.measurable_outcome} />
              </div>
              <Field label="90-day mission" value={g90?.goal_description} />
              <Field
                label="My Core Why"
                value={w7?.answer_text ?? (isPrivateWhy(w7) ? <PrivateShort /> : null)}
              />
              <Field
                label="What I am trying to create or protect"
                value={
                  w6?.answer_text ??
                  whyCategoryLabels(w6) ??
                  (isPrivateWhy(w6) ? <PrivateShort /> : null)
                }
              />
              <Field
                label="Cost of staying the same"
                value={
                  w5?.answer_text ??
                  whyCategoryLabels(w5) ??
                  (isPrivateWhy(w5) ? <PrivateShort /> : null)
                }
              />
            </SectionCard>

            {/* B — Belief / constraint map */}
            <SectionCard section="B" title="Belief / constraint map">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="Perceived income ceiling"
                  value={
                    beliefs?.current_ceiling_amount != null
                      ? fmtMoney(beliefs.current_ceiling_amount)
                      : null
                  }
                />
                <Field
                  label="Primary constraint"
                  value={constraintLabel(beliefs?.primary_constraint_category)}
                />
              </div>
              <Field label="What makes it feel like a ceiling" value={beliefs?.stated_ceiling_reason} />
              <Field
                label="Belief categories"
                value={
                  <Bullets slugs={beliefs?.belief_categories_json} opts={BELIEF_CATEGORY_OPTIONS} />
                }
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Fact" value={beliefs?.fact_statement} />
                <Field label="Story" value={beliefs?.story_statement} />
              </div>
              <Field
                label="Where the story came from"
                value={
                  <Bullets
                    slugs={beliefs?.belief_source_categories_json}
                    opts={STORY_ORIGIN_OPTIONS}
                  />
                }
              />
              <Field label="Belief to question" value={beliefs?.belief_to_question} />
              <Field
                label="Development gaps"
                value={
                  <Bullets
                    slugs={beliefs?.development_gap_categories_json}
                    opts={PERSONAL_GAP_OPTIONS}
                  />
                }
              />
              <Field
                label="Professional focus"
                value={
                  gPro ? (
                    <>
                      {gPro.goal_title ?? optionLabel(PRO_FOCUS_OPTIONS, gPro.life_area)}
                      {gPro.goal_description && (
                        <span className="block text-sm text-[var(--purpose-ink-dim)]">
                          {gPro.goal_description}
                        </span>
                      )}
                    </>
                  ) : null
                }
              />
            </SectionCard>

            {/* C — Seven Whys (masked by the leadership RPC; categories always show) */}
            <SectionCard section="C" title="Seven Whys">
              {[1, 2, 3, 4, 5, 6, 7].map((lvl) => {
                const w = why(lvl);
                const isCore = lvl === 7;
                const cats = whyCategoryLabels(w);
                return (
                  <div
                    key={lvl}
                    className={cn(
                      isCore &&
                        "rounded-xl border border-[var(--purpose-tide)] bg-[color-mix(in_oklab,var(--purpose-tide)_10%,transparent)] p-4",
                    )}
                  >
                    <PurposeLabel className={isCore ? "text-[var(--purpose-tide)]" : undefined}>
                      {isCore ? "Level 7 — My Core Why" : `Level ${lvl}`}
                    </PurposeLabel>
                    {w?.prompt_text && (
                      <p className="mt-1 text-xs leading-relaxed text-[var(--purpose-ink-dim)]">
                        {w.prompt_text}
                      </p>
                    )}
                    {w?.answer_text ? (
                      <p className="mt-1 whitespace-pre-line text-base leading-relaxed">
                        {w.answer_text}
                      </p>
                    ) : isPrivateWhy(w) ? (
                      <div className="mt-1">
                        <PrivateShort />
                        <p className="mt-0.5 text-xs text-[var(--purpose-ink-dim)]">
                          {EMPTY_STATE_COPY.private_field}
                        </p>
                      </div>
                    ) : !cats ? (
                      <p className="mt-1">
                        <Dash />
                      </p>
                    ) : null}
                    {cats && (
                      <p className="mt-1 text-sm text-[var(--purpose-sand)]">{cats}</p>
                    )}
                  </div>
                );
              })}
            </SectionCard>

            {/* D — Support / accountability */}
            <SectionCard section="D" title="Support / accountability">
              <Field
                label="Personal support focus"
                value={
                  gPersonal ? (
                    <>
                      {gPersonal.goal_title ??
                        optionLabel(PERSONAL_FOCUS_OPTIONS, gPersonal.life_area)}
                      {gPersonal.goal_description && (
                        <span className="block text-sm text-[var(--purpose-ink-dim)]">
                          {gPersonal.goal_description}
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="italic text-[var(--purpose-ink-dim)]">
                      {EMPTY_STATE_COPY.private_field}
                    </span>
                  )
                }
              />
              <Field
                label="Internal obstacle"
                value={<Bullets slugs={obstacles} opts={OBSTACLE_OPTIONS} />}
              />
              <div>
                <PurposeLabel>If–then plan</PurposeLabel>
                {ifThen?.trigger_statement || ifThen?.response_statement ? (
                  <div className="mt-2 space-y-2 rounded-xl border border-[var(--purpose-line)] p-4">
                    <p className="text-base leading-relaxed">
                      <span className="mr-2 text-xs font-semibold uppercase tracking-wider text-[var(--purpose-tide)]">
                        If
                      </span>
                      {ifThen.trigger_statement ?? "—"}
                    </p>
                    <p className="text-base leading-relaxed">
                      <span className="mr-2 text-xs font-semibold uppercase tracking-wider text-[var(--purpose-tide)]">
                        Then
                      </span>
                      {ifThen.response_statement ?? "—"}
                    </p>
                  </div>
                ) : (
                  <p className="mt-1">
                    <Dash />
                  </p>
                )}
              </div>
              <Field
                label="Requested help"
                value={
                  supportSelections.length > 0 || supportJson?.context ? (
                    <>
                      <Bullets slugs={supportSelections} opts={SUPPORT_REQUEST_OPTIONS} />
                      {supportJson?.context && (
                        <span className="mt-1 block text-sm text-[var(--purpose-ink-dim)]">
                          {supportJson.context}
                        </span>
                      )}
                    </>
                  ) : null
                }
              />
              <Field label="90-day identity commitment" value={identityCommitment} />
            </SectionCard>

            {/* E — Existing CRM performance: real numbers already available to
                leadership. No commissions, no invented comparisons. */}
            <SectionCard section="E" title="Existing CRM performance">
              {scoreboard.loading ? (
                <p className="text-sm text-[var(--purpose-ink-dim)]">Loading this week…</p>
              ) : !scoreboard.matched || !week ? (
                <p className="text-sm leading-relaxed text-[var(--purpose-ink-dim)]">
                  {EMPTY_STATE_COPY.no_crm}
                </p>
              ) : (
                <div>
                  <PurposeLabel>This week</PurposeLabel>
                  <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <Stat label="Sits" value={week.pm + week.sold} />
                    <Stat label="Sales" value={week.sold} />
                    <Stat label="Volume" value={fmtMoney(week.revenue)} />
                    <Stat label="Close" value={fmtPct(week.closePct)} />
                  </div>
                  {scoreboard.trailing && (
                    <p className="mt-3 text-xs leading-relaxed text-[var(--purpose-ink-dim)]">
                      Trailing 2 weeks: {scoreboard.trailing.sold} sales ·{" "}
                      {fmtMoney(scoreboard.trailing.revenue)} volume
                    </p>
                  )}
                </div>
              )}
            </SectionCard>

            {/* F — Leadership actions */}
            <PurposeLeadershipActions detail={detail} />

            {/* Reflections the rep chose to share */}
            {sharedReflections.length > 0 && (
              <PurposeCard className="mt-4">
                <PurposeLabel>Reflections shared with leadership</PurposeLabel>
                <div className="mt-3 space-y-3">
                  {sharedReflections.map((r) => (
                    <div key={r.id}>
                      <div className="text-xs tabular-nums text-[var(--purpose-ink-dim)]">
                        {fmtDate(r.reflection_date)}
                      </div>
                      <p className="mt-0.5 text-sm leading-relaxed">{r.answer_text}</p>
                    </div>
                  ))}
                </div>
              </PurposeCard>
            )}
          </>
        )}
      </div>
    </div>
  );
}
