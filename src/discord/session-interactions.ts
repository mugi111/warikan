import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle,
  type Interaction, type UserSelectMenuInteraction, type StringSelectMenuInteraction,
} from "discord.js";
import { ApplicationError } from "../application/errors.js";
import { SessionService } from "../application/session-service.js";
import type { MemberSettingsInput, SessionDto } from "../application/types.js";
import { makeCustomId, parseCustomId } from "./custom-id.js";
import { ExpenseDraftStore } from "./expense-drafts.js";
import { expenseDetailView, expenseDraftView, expenseListView, fieldsModal, memberView, sessionDetailView, sessionListView, settingsModal } from "./session-views.js";

const drafts = new ExpenseDraftStore();
const mentions = { parse: [] as never[] };
const privateReply = { flags: MessageFlags.Ephemeral as const, allowedMentions: mentions };
const errorText: Record<string, string> = {
  INVALID_INPUT: "入力内容を確認してください。", NOT_FOUND: "対象を確認できませんでした。",
  FORBIDDEN: "対象を確認できませんでした。", SESSION_NOT_ACTIVE: "このセッションは編集できません。",
  REVISION_CONFLICT: "セッションが更新されています。最新の画面を開き直してください。",
  MEMBER_NOT_FOUND: "参加者が見つかりません。", MEMBER_IN_USE: "支出に使用中の参加者は削除できません。",
  EMPTY_EXPENSE_MEMBERS: "対象者を1人以上選択してください。", DUPLICATE_MEMBER: "参加者が重複しています。",
  ADJUSTMENTS_NOT_ZERO: "固定額調整の合計を0円にしてください。", NEGATIVE_SHARE: "調整後の負担額が0円未満になります。",
  AMOUNT_OVERFLOW: "金額が上限を超えています。", STORAGE_BUSY: "保存処理が混み合っています。しばらくして再試行してください。",
};

export async function handleSessionInteraction(service: SessionService, interaction: Interaction): Promise<void> {
  if (interaction.isChatInputCommand() && interaction.commandName === "warikan") {
    if (!interaction.inGuild() || !interaction.guildId) { await interaction.reply({ ...privateReply, content: "サーバー内で実行してください。" }); return; }
    await interaction.deferReply(privateReply);
    try { await interaction.editReply({ ...sessionListView(service.listSessions(interaction.guildId, interaction.user.id), 0), allowedMentions: mentions }); }
    catch (error) { await interaction.editReply({ content: toUserError(error), embeds: [], components: [], allowedMentions: mentions }); }
    return;
  }
  if (!interaction.isMessageComponent() && !interaction.isModalSubmit()) return;
  if (!interaction.customId.startsWith("wk1:")) return;
  if (!interaction.inGuild() || !interaction.guildId) {
    if (interaction.isModalSubmit()) await interaction.reply({ ...privateReply, content: "サーバー内で実行してください。" });
    else await interaction.reply({ ...privateReply, content: "サーバー内で実行してください。" });
    return;
  }
  const parsed = parseCustomId(interaction.customId);
  if (!parsed) return acknowledgeError(interaction, "この操作は期限切れです。画面を開き直してください。");
  const { action, sessionId, revision, arg } = parsed;
  const guild = interaction.guildId;
  const actor = interaction.user.id;
  if (action === "list" || (action === "page" && !sessionId) || action === "new") {
    if (interaction.isModalSubmit()) return acknowledgeError(interaction, "操作を確認できません。");
    if (action === "new") {
      const modal = new ModalBuilder().setCustomId(makeCustomId("create")).setTitle("新しいセッション").addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("name").setLabel("セッション名").setStyle(TextInputStyle.Short).setMaxLength(80).setRequired(true)));
      await interaction.showModal(modal); return;
    }
    await acknowledgeUpdate(interaction);
    const page = action === "page" ? Number.parseInt(arg, 10) : 0;
    await interaction.editReply({ ...sessionListView(service.listSessions(guild, actor), Number.isSafeInteger(page) ? Math.max(0, page) : 0), allowedMentions: mentions }); return;
  }
  if (action === "create" && interaction.isModalSubmit()) {
    await interaction.deferReply(privateReply);
    try { const created = service.createSession({ guildDiscordId: guild, actorDiscordUserId: actor, name: interaction.fields.getTextInputValue("name").trim() }); await interaction.editReply({ ...sessionDetailView(created, actor), allowedMentions: mentions }); }
    catch (error) { await interaction.editReply({ content: toUserError(error), embeds: [], components: [], allowedMentions: mentions }); }
    return;
  }
  if (action === "open" && interaction.isStringSelectMenu()) {
    const selected = interaction.values[0]; if (!selected) return acknowledgeError(interaction, "選択内容を確認できません。");
    try { const opened = service.getSession({ guildDiscordId: guild, actorDiscordUserId: actor, sessionId: normalizeUuid(selected) }); await interaction.update({ ...sessionDetailView(opened), allowedMentions: mentions }); }
    catch (error) { return acknowledgeError(interaction, toUserError(error)); } return;
  }
  if (!sessionId) return acknowledgeError(interaction, "セッションを確認できません。");
  const scope = { guildDiscordId: guild, actorDiscordUserId: actor, sessionId };
  let session: SessionDto;
  try { session = service.getSession(scope); }
  catch (error) { return acknowledgeError(interaction, toUserError(error)); }
  if (session.revision !== revision && action !== "open") return acknowledgeError(interaction, "セッションが更新されています。最新の画面を開き直してください。");
  if (interaction.isModalSubmit()) {
    if (action === "fields" || action === "settings") await interaction.deferUpdate();
    else await interaction.deferReply(privateReply);
    try {
      if (action === "fields") {
        const [token, generation] = arg.split("_");
        const draft = drafts.get(token ?? "", actor, guild, session.id, revision);
        if (!draft || draft.generation.toString(36) !== generation) throw new ApplicationError("REVISION_CONFLICT", "Draft expired.");
        draft.title = interaction.fields.getTextInputValue("title").trim();
        draft.amount = interaction.fields.getTextInputValue("amount").trim();
        draft.generation += 1;
        await interaction.editReply({ ...expenseDraftView(session, draft), allowedMentions: mentions }); return;
      }
      if (action === "settings") {
        if (session.creatorDiscordUserId !== actor) throw new ApplicationError("FORBIDDEN", "Only the creator can edit settings.");
        const rows = interaction.fields.getTextInputValue("settings").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        const active = session.members.filter((m) => !m.removedAt);
        const settingsByMember = new Map<string, MemberSettingsInput>(active.map((member) => [member.id, {
          memberId: member.id, weight: member.weight, fixedAdjustment: member.fixedAdjustment,
        }]));
        const touched = new Set<string>();
        for (const line of rows) {
          const match = /^(?:<@!?(\d+)>|(\d+))\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(-?\d+)$/.exec(line);
          if (!match) throw new ApplicationError("INVALID_INPUT", "Invalid member settings line.");
          const member = active.find((m) => m.discordUserId === (match[1] ?? match[2]));
          if (!member) throw new ApplicationError("MEMBER_NOT_FOUND", "Unknown active member.");
          if (touched.has(member.id)) throw new ApplicationError("DUPLICATE_MEMBER", "Member settings must not contain duplicates.");
          const weight = Number(match[3]); const fixedAdjustment = Number(match[4]);
          if (!Number.isFinite(weight) || weight <= 0 || !Number.isSafeInteger(fixedAdjustment)) throw new ApplicationError("INVALID_INPUT", "Invalid settings values.");
          touched.add(member.id);
          settingsByMember.set(member.id, { memberId: member.id, weight, fixedAdjustment });
        }
        if (settingsByMember.size === 0) throw new ApplicationError("INVALID_INPUT", "Add a participant before changing settings.");
        const settings = [...settingsByMember.values()];
        const updated = service.updateMemberSettings(scope, settings, { expectedRevision: revision });
        await interaction.editReply({ ...sessionDetailView(updated), allowedMentions: mentions }); return;
      }
      if (action === "create") throw new Error("Invalid creation context");
      throw new ApplicationError("INVALID_INPUT", "Unsupported form.");
    } catch (error) { await interaction.editReply({ content: toUserError(error), embeds: [], components: [], allowedMentions: mentions }); }
    return;
  }
  if (!interaction.isMessageComponent()) return;
  if (action === "page") { await interaction.update({ ...sessionDetailView(session, actor), allowedMentions: mentions }); return; }
  if (action === "draft") {
    if (session.status !== "ACTIVE") return acknowledgeError(interaction, "このセッションは編集できません。");
    const expense = arg === "new" ? undefined : session.expenses.find((item) => item.id.replaceAll("-", "") === arg);
    if (arg !== "new" && !expense) return acknowledgeError(interaction, "支出が見つかりません。");
    if (expense && session.creatorDiscordUserId !== actor) return acknowledgeError(interaction, "対象を確認できませんでした。");
    const draft = drafts.create(actor, guild, session, expense);
    await interaction.update({ ...expenseDraftView(session, draft), allowedMentions: mentions }); return;
  }
  if (["payer", "target", "untarget", "all", "fields", "save", "cancel"].includes(action)) {
    const [token, generation] = arg.split("_");
    const draft = drafts.get(token ?? "", actor, guild, session.id, revision);
    if (!draft || draft.generation.toString(36) !== generation) return acknowledgeError(interaction, "入力画面の期限が切れました。開き直してください。");
    if (action === "fields") { await interaction.showModal(fieldsModal(makeCustomId("fields", session.id, revision, `${draft.token}_${draft.generation.toString(36)}`), draft.title, draft.amount)); return; }
    if (action === "cancel") { drafts.delete(draft.token); await interaction.update({ ...sessionDetailView(session), allowedMentions: mentions }); return; }
    if (action === "save") {
      const amount = /^\d+$/.test(draft.amount) ? Number(draft.amount) : NaN;
      if (!draft.title || !Number.isSafeInteger(amount) || amount <= 0 || !draft.payer) return acknowledgeError(interaction, "支出名、正の金額、支払者を入力してください。");
      if (!draft.eligible.size) return acknowledgeError(interaction, "対象者を1人以上選択してください。");
      try {
        const input = { title: draft.title, amount, payerMemberId: draft.payer, eligibleMemberIds: [...draft.eligible] };
        const updated = draft.expenseId ? service.updateExpense(scope, draft.expenseId, input, { expectedRevision: revision }) : service.createExpense(scope, input, { expectedRevision: revision });
        drafts.delete(draft.token); await interaction.update({ ...expenseListView(updated, 0), allowedMentions: mentions });
      } catch (error) { return acknowledgeError(interaction, toUserError(error)); } return;
    }
    if (action === "all") { draft.allEligible = !draft.allEligible; draft.eligible = new Set(draft.allEligible ? session.members.filter((m) => !m.removedAt).map((m) => m.id) : []); }
    else if ((action === "payer" || action === "target" || action === "untarget") && interaction.isUserSelectMenu()) {
      const selected = session.members.filter((m) => !m.removedAt && interaction.values.includes(m.discordUserId));
      if (selected.length !== interaction.values.length) return acknowledgeError(interaction, "選択したユーザーはこのセッションの参加者ではありません。");
      if (action === "payer") draft.payer = selected[0]!.id;
      else for (const member of selected) action === "target" ? draft.eligible.add(member.id) : draft.eligible.delete(member.id);
      draft.allEligible = draft.eligible.size === session.members.filter((m) => !m.removedAt).length;
    }
    draft.generation += 1;
    await interaction.update({ ...expenseDraftView(session, draft), allowedMentions: mentions }); return;
  }
  if (action === "settings") {
    if (session.creatorDiscordUserId !== actor || session.status !== "ACTIVE") return acknowledgeError(interaction, "対象を確認できませんでした。");
    await interaction.showModal(settingsModal(makeCustomId("settings", session.id, revision), session)); return;
  }
  if (["members", "mpage", "expenses", "epage", "expense"].includes(action)) {
    if (action === "expense" && interaction.isStringSelectMenu()) {
      const selected = interaction.values[0]; const expense = session.expenses.find((e) => e.id.replaceAll("-", "") === selected);
      if (!expense) return acknowledgeError(interaction, "支出が見つかりません。");
      await interaction.update({ ...expenseDetailView(session, expense, actor), allowedMentions: mentions }); return;
    }
    const page = Number.parseInt(arg, 10); const p = Number.isSafeInteger(page) ? Math.max(0, page) : 0;
    await interaction.update({ ...(action === "members" || action === "mpage" ? memberView(session, p, actor) : action === "expenses" ? expenseListView(session, 0) : expenseListView(session, p)), allowedMentions: mentions }); return;
  }
  if (action === "add" && interaction.isUserSelectMenu()) {
    if (actor !== session.creatorDiscordUserId || session.status !== "ACTIVE") return acknowledgeError(interaction, "対象を確認できませんでした。");
    try { const updated = service.addMembers(scope, interaction.values, { expectedRevision: revision }); await interaction.update({ ...memberView(updated, 0, actor), allowedMentions: mentions }); }
    catch (error) { return acknowledgeError(interaction, toUserError(error)); } return;
  }
  if (action === "remove" && interaction.isStringSelectMenu()) {
    if (actor !== session.creatorDiscordUserId || session.status !== "ACTIVE") return acknowledgeError(interaction, "対象を確認できませんでした。");
    const memberId = interaction.values[0]; if (!memberId) return acknowledgeError(interaction, "参加者を選択してください。");
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(makeCustomId("rmconfirm", session.id, revision, memberId.replaceAll("-", ""))).setLabel("削除を確定").setStyle(ButtonStyle.Danger));
    await interaction.reply({ ...privateReply, content: "この参加者をセッションから削除しますか？", components: [row] }); return;
  }
  if (action === "rmconfirm") {
    if (actor !== session.creatorDiscordUserId || session.status !== "ACTIVE") return acknowledgeError(interaction, "対象を確認できませんでした。");
    try { const updated = service.removeMember(scope, normalizeUuid(arg), { expectedRevision: revision }); await interaction.update({ ...memberView(updated, 0, actor), allowedMentions: mentions }); }
    catch (error) { return acknowledgeError(interaction, toUserError(error)); } return;
  }
  if (action === "delete") {
    if (actor !== session.creatorDiscordUserId || session.status !== "ACTIVE") return acknowledgeError(interaction, "対象を確認できませんでした。");
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(makeCustomId("delconfirm", session.id, revision, arg)).setLabel("削除を確定").setStyle(ButtonStyle.Danger));
    await interaction.reply({ ...privateReply, content: "この支出を削除しますか？", components: [row] }); return;
  }
  if (action === "delconfirm") {
    if (actor !== session.creatorDiscordUserId || session.status !== "ACTIVE") return acknowledgeError(interaction, "対象を確認できませんでした。");
    try { const updated = service.deleteExpense(scope, normalizeUuid(arg), { expectedRevision: revision }); await interaction.update({ ...expenseListView(updated, 0), allowedMentions: mentions }); }
    catch (error) { return acknowledgeError(interaction, toUserError(error)); } return;
  }
  return acknowledgeError(interaction, "この操作には対応していません。");
}

async function acknowledgeUpdate(interaction: Interaction): Promise<void> {
  if (interaction.isMessageComponent()) await interaction.deferUpdate();
}

async function acknowledgeError(interaction: Interaction, content: string): Promise<void> {
  if (interaction.isMessageComponent() || interaction.isModalSubmit()) {
    if (interaction.deferred || interaction.replied) await interaction.followUp({ ...privateReply, content, allowedMentions: mentions });
    else await interaction.reply({ ...privateReply, content, allowedMentions: mentions });
  }
}

function normalizeUuid(value: string): string {
  if (!/^[0-9a-f]{32}$/i.test(value)) throw new ApplicationError("INVALID_INPUT", "Invalid identifier.");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function toUserError(error: unknown): string {
  if (error instanceof ApplicationError) return errorText[error.code] ?? "操作を完了できませんでした。";
  return "操作を完了できませんでした。時間をおいて再試行してください。";
}
