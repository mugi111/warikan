import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder,
  UserSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
} from "discord.js";
import type { ExpenseDto, SessionDto } from "../application/types.js";
import { makeCustomId } from "./custom-id.js";
import type { ExpenseDraft } from "./expense-drafts.js";

const safe = (value: string, limit = 90): string => value.replace(/[`*_~|>]/g, "\\$&").slice(0, limit);
const id = (action: string, s: SessionDto, arg = ""): string => makeCustomId(action, s.id, s.revision, arg);
const button = (label: string, customId: string, style = ButtonStyle.Secondary): ButtonBuilder => new ButtonBuilder().setLabel(label).setCustomId(customId).setStyle(style);
const accent = 0x438b73;
const statusLabel = (status: SessionDto["status"]): string => status === "ACTIVE" ? "進行中" : status === "SETTLING" ? "精算中" : "完了";
const yen = (amount: number): string => `${amount.toLocaleString()}円`;

export function sessionListView(sessions: SessionDto[], page: number) {
  const pages = Math.max(1, Math.ceil(sessions.length / 10));
  const current = Math.min(page, pages - 1);
  const slice = sessions.slice(current * 10, current * 10 + 10);
  const embed = new EmbedBuilder().setColor(accent).setTitle("割り勘").setDescription(slice.length ? slice.map((s) => `**${safe(s.name)}**　${statusLabel(s.status)}\n${s.members.filter((m) => !m.removedAt).length}人 · ${s.expenses.length}件 · ${yen(s.expenses.reduce((sum, expense) => sum + expense.amount, 0))}`).join("\n\n") : "セッションはまだありません。\n新しく作成して、参加者を追加しましょう。").setFooter({ text: sessions.length ? `${sessions.length}件のセッション · ${current + 1}/${pages}ページ` : "まずはセッションを作成" });
  const rows: ActionRowBuilder<any>[] = [];
  if (slice.length) {
    const menu = new StringSelectMenuBuilder().setCustomId(makeCustomId("open", "", 0, String(current))).setPlaceholder("セッションを選択").addOptions(slice.map((s) => ({ label: safe(s.name, 100), value: s.id.replaceAll("-", ""), description: `${s.members.filter((m) => !m.removedAt).length}人 · ${s.expenses.length}件` })));
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu));
  }
  const controls = [button("新しいセッション", makeCustomId("new"), ButtonStyle.Primary)];
  if (pages > 1) controls.push(
    button("前へ", makeCustomId("page", "", 0, `${Math.max(0, current - 1)}_prev`)).setDisabled(current === 0),
    button("次へ", makeCustomId("page", "", 0, `${Math.min(pages - 1, current + 1)}_next`)).setDisabled(current >= pages - 1),
  );
  rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...controls));
  return { embeds: [embed], components: rows };
}

export function sessionDetailView(s: SessionDto, actor = "") {
  const active = s.members.filter((member) => member.removedAt === null);
  const total = s.expenses.reduce((sum, expense) => sum + expense.amount, 0);
  const nextStep = s.status === "SETTLING" ? "未払いの送金を確認してください。" : s.status === "CLOSED" ? "このセッションの精算は完了しています。" : active.length < 2 ? "参加者を追加すると、支出を登録できます。" : s.expenses.length === 0 ? "支出を登録すると、精算額を確認できます。" : "支出を確認して、精算額をプレビューできます。";
  const embed = new EmbedBuilder().setColor(accent).setTitle(safe(s.name, 256)).setDescription(`${nextStep}\n\n作成者 <@${s.creatorDiscordUserId}>`).addFields(
    { name: "状態", value: statusLabel(s.status), inline: true },
    { name: "参加者", value: `${active.length}人`, inline: true },
    { name: "支出合計", value: yen(total), inline: true },
    { name: "支出", value: `${s.expenses.length}件`, inline: true },
  );
  const rows: ActionRowBuilder<any>[] = [];
  if (s.status === "ACTIVE") {
    const actions = active.length < 2
      ? [button("参加者を追加", id("members", s), ButtonStyle.Primary)]
      : [button("支出を確認", id("expenses", s)), button("支出を追加", id("draft", s, "new"), ButtonStyle.Success)];
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...actions));
    if (s.expenses.length) rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(button("精算をプレビュー", id("preview", s), ButtonStyle.Primary)));
  } else rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(button("精算結果を確認", id("settlement", s, ""), ButtonStyle.Primary), ...(s.status === "SETTLING" ? [button("リマインド", id("reminder", s))] : [])));
  rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(button("参加者", id("members", s)), ...(s.status === "ACTIVE" && s.creatorDiscordUserId === actor ? [button("負担設定", id("settings", s)), button("名前を変更", id("rename", s))] : []), button("セッション一覧へ", makeCustomId("list"))));
  return { embeds: [embed], components: rows };
}

export function memberView(s: SessionDto, page: number, actor = "") {
  const active = s.members.filter((m) => !m.removedAt);
  const pages = Math.max(1, Math.ceil(active.length / 10));
  const current = Math.min(page, pages - 1);
  const rows: ActionRowBuilder<any>[] = [];
  const pageControls = pages > 1 ? [
    button("前へ", id("mpage", s, `${Math.max(0, current - 1)}_prev`)).setDisabled(current === 0),
    button("次へ", id("mpage", s, `${Math.min(pages - 1, current + 1)}_next`)).setDisabled(current >= pages - 1),
  ] : [];
  rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...pageControls, button("セッションへ戻る", id("page", s, "0"))));
  if (s.creatorDiscordUserId === actor && s.status === "ACTIVE") {
    rows.push(new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(new UserSelectMenuBuilder().setCustomId(id("add", s)).setPlaceholder("参加者を追加（最大25人）").setMinValues(1).setMaxValues(25)));
    if (active.length) rows.push(new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(new UserSelectMenuBuilder().setCustomId(id("remove", s)).setPlaceholder("削除する参加者を選択").setMinValues(1).setMaxValues(1)));
  }
  return { embeds: [new EmbedBuilder().setColor(accent).setTitle(`参加者 · ${active.length}人`).setDescription(active.slice(current * 10, current * 10 + 10).map((m) => `<@${m.discordUserId}> · 負担倍率 ${m.weight} · 調整 ${yen(m.fixedAdjustment)}`).join("\n") || "参加者はいません")], components: rows };
}

export function expenseListView(s: SessionDto, page: number) {
  const pages = Math.max(1, Math.ceil(s.expenses.length / 10)); const current = Math.min(page, pages - 1);
  const items = s.expenses.slice(current * 10, current * 10 + 10);
  const rows: ActionRowBuilder<any>[] = [];
  if (items.length) rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId(id("expense", s, String(current))).setPlaceholder("支出を選択").addOptions(items.map((e) => ({ label: safe(e.title, 100), value: e.id.replaceAll("-", ""), description: `${e.amount.toLocaleString()}円` })))));
  const pageControls = pages > 1 ? [
    button("前へ", id("epage", s, `${Math.max(0, current - 1)}_prev`)).setDisabled(current === 0),
    button("次へ", id("epage", s, `${Math.min(pages - 1, current + 1)}_next`)).setDisabled(current >= pages - 1),
  ] : [];
  rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...pageControls, ...(s.status === "ACTIVE" ? [button("支出を追加", id("draft", s, "new"), ButtonStyle.Success)] : []), button("セッションへ戻る", id("page", s, "0"))));
  return { embeds: [new EmbedBuilder().setColor(accent).setTitle(`支出 · ${s.expenses.length}件`).setDescription(items.map((e) => `**${safe(e.title)}** · ${yen(e.amount)}`).join("\n") || "支出はまだありません。\n「支出を追加」から登録できます。").setFooter({ text: `合計 ${yen(s.expenses.reduce((sum, expense) => sum + expense.amount, 0))}` })], components: rows };
}

export function expenseDetailView(s: SessionDto, e: ExpenseDto, actor = "") {
  const payer = s.members.find((m) => m.id === e.payerMemberId);
  const embed = new EmbedBuilder().setTitle(safe(e.title, 256)).setDescription(`${e.amount.toLocaleString()}円\n支払者 <@${payer?.discordUserId ?? ""}>\n対象 ${e.eligibleMemberIds.length}人`).setFooter({ text: `更新番号 ${s.revision}` });
  const controls = s.creatorDiscordUserId === actor && s.status === "ACTIVE" ? [button("編集", id("draft", s, e.id.replaceAll("-", "")), ButtonStyle.Primary), button("削除", id("delete", s, e.id.replaceAll("-", "")), ButtonStyle.Danger)] : [];
  const rows = [new ActionRowBuilder<ButtonBuilder>().addComponents(...controls, button("支出一覧へ戻る", id("expenses", s)))];
  return { embeds: [embed], components: rows };
}

export function expenseDraftView(s: SessionDto, d: ExpenseDraft, displayNames: ReadonlyMap<string, string> = new Map()) {
  const generation = d.generation.toString(36);
  const cmd = (a: string) => makeCustomId(a, s.id, s.revision, `${d.token}_${generation}`);
  const calc = (key: string) => makeCustomId("calc", s.id, s.revision, `${d.token}_${generation}_${key}`);
  const members = s.members.filter((m) => !m.removedAt);
  const pageSize = 25;
  const pages = Math.max(1, Math.ceil(members.length / pageSize));
  d.memberPage = Math.max(0, Math.min(d.memberPage, pages - 1));
  const memberPage = members.slice(d.memberPage * pageSize, (d.memberPage + 1) * pageSize);
  const options = memberPage.map((member, index) => ({
    label: (displayNames.get(member.id) ?? `参加者 ${d.memberPage * pageSize + index + 1}`).slice(0, 100),
    value: member.id,
    description: d.eligible.has(member.id) ? "現在の対象" : "対象外",
  }));
  const paging = pages > 1 ? [
    button("前へ", makeCustomId("dpage", s.id, s.revision, `${d.token}_${generation}_${Math.max(0, d.memberPage - 1)}_prev`)).setDisabled(d.memberPage === 0),
    button("次へ", makeCustomId("dpage", s.id, s.revision, `${d.token}_${generation}_${Math.min(pages - 1, d.memberPage + 1)}_next`)).setDisabled(d.memberPage >= pages - 1),
  ] : [];
  const rows: ActionRowBuilder<any>[] = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(button("内容・金額を入力", cmd("fields"), ButtonStyle.Primary), button("電卓", calc("open")), button(d.allEligible ? "全員が対象" : "全員を対象", cmd("all"), d.allEligible ? ButtonStyle.Success : ButtonStyle.Secondary), ...paging),
  ];
  if (d.calculatorOpen) {
    const keypad = [["7", "8", "9", "mul"], ["4", "5", "6", "add"], ["1", "2", "3", "back"], ["0", "00", "clear", "equals"]];
    const labels: Record<string, string> = { mul: "×", add: "+", back: "⌫", clear: "C", equals: "=" };
    const calculatorRows = keypad.map((keys) => new ActionRowBuilder<ButtonBuilder>().addComponents(...keys.map((key) => button(labels[key] ?? key, calc(key), key === "equals" ? ButtonStyle.Success : ButtonStyle.Secondary))));
    return { embeds: [new EmbedBuilder().setColor(accent).setTitle("金額の電卓").setDescription(`**${safe(d.expression || "0", 40)}**\n\n${d.expression.includes("+") || d.expression.includes("×") ? "式を入力して「=」で合計を反映します。" : "円単位で入力できます。"}`)], components: [...calculatorRows, new ActionRowBuilder<ButtonBuilder>().addComponents(button("入力画面へ戻る", calc("close"), ButtonStyle.Primary))] };
  }
  if (options.length) {
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId(cmd("payer")).setPlaceholder("支払者を選択").setMinValues(1).setMaxValues(1).addOptions(options)));
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId(cmd("target")).setPlaceholder("対象者を追加").setMinValues(1).setMaxValues(options.length).addOptions(options)));
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId(cmd("untarget")).setPlaceholder("対象者から除外").setMinValues(1).setMaxValues(options.length).addOptions(options)));
  }
  const payer = members.find((m) => m.id === d.payer);
  const eligible = members.filter((member) => d.eligible.has(member.id));
  const validAmount = /^\d+$/.test(d.amount) && Number.isSafeInteger(Number(d.amount)) && Number(d.amount) > 0;
  const targetSummary = d.allEligible ? "全員" : eligible.length ? `${eligible.slice(0, 8).map((member) => `<@${member.discordUserId}>`).join("、")}${eligible.length > 8 ? ` ほか${eligible.length - 8}人` : ""}` : "未選択";
  rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(button("保存", cmd("save"), ButtonStyle.Success).setDisabled(!d.title.trim() || !validAmount || !payer || eligible.length === 0), button("キャンセル", cmd("cancel"))));
  return { embeds: [new EmbedBuilder().setColor(accent).setTitle(d.expenseId ? "支出を編集" : "支出を追加").setDescription(`支出名と金額を入力し、支払者と対象者を確認してください。\n\n**${safe(d.title || "支出名 未入力")}**　${validAmount ? yen(Number(d.amount)) : "金額 未入力"}\n支払者　${payer ? `<@${payer.discordUserId}>` : "未選択"}\n対象者　${targetSummary}\n参加者候補 ${d.memberPage + 1}/${pages}ページ`)], components: rows };
}

export function fieldsModal(customId: string, title = "", amount = ""): ModalBuilder {
  return new ModalBuilder().setCustomId(customId).setTitle("支出内容").addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("title").setLabel("支出名").setStyle(TextInputStyle.Short).setMaxLength(100).setValue(title).setRequired(true)),
    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("amount").setLabel("金額（円）").setStyle(TextInputStyle.Short).setMaxLength(16).setValue(amount).setRequired(true)),
  );
}

export function settingsModal(customId: string, s: SessionDto): ModalBuilder {
  const lines: string[] = [];
  for (const member of s.members.filter((m) => !m.removedAt)) {
    const line = `<@${member.discordUserId}>, ${member.weight}, ${member.fixedAdjustment}`;
    if (lines.join("\n").length + line.length + 1 > 3600) break;
    lines.push(line);
  }
  const values = lines.join("\n") || "ユーザーID, 1, 0";
  return new ModalBuilder().setCustomId(customId).setTitle("参加者の負担設定").addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("settings").setLabel("メンション, 負担倍率, 調整額（円）").setStyle(TextInputStyle.Paragraph).setMaxLength(4000).setValue(values).setRequired(true)));
}

export function renameSessionModal(customId: string, name: string): ModalBuilder {
  return new ModalBuilder().setCustomId(customId).setTitle("セッション名変更").addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("name").setLabel("セッション名").setStyle(TextInputStyle.Short).setMaxLength(80).setValue(name).setRequired(true)),
  );
}
