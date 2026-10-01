import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder,
  UserSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  type APIEmbed,
} from "discord.js";
import type { ExpenseDto, SessionDto } from "../application/types.js";
import { makeCustomId } from "./custom-id.js";
import type { ExpenseDraft } from "./expense-drafts.js";

const safe = (value: string, limit = 90): string => value.replace(/[`*_~|>]/g, "\\$&").slice(0, limit);
const id = (action: string, s: SessionDto, arg = ""): string => makeCustomId(action, s.id, s.revision, arg);
const button = (label: string, customId: string, style = ButtonStyle.Secondary): ButtonBuilder => new ButtonBuilder().setLabel(label).setCustomId(customId).setStyle(style);

export function sessionListView(sessions: SessionDto[], page: number) {
  const pages = Math.max(1, Math.ceil(sessions.length / 10));
  const current = Math.min(page, pages - 1);
  const slice = sessions.slice(current * 10, current * 10 + 10);
  const embed = new EmbedBuilder().setTitle("割り勘セッション").setDescription(slice.length ? slice.map((s, i) => `**${current * 10 + i + 1}. ${safe(s.name)}** · ${s.status === "ACTIVE" ? "進行中" : s.status === "SETTLING" ? "精算中" : "完了"}`).join("\n") : "参加中のセッションはありません。");
  const rows: ActionRowBuilder<any>[] = [];
  if (slice.length) {
    const menu = new StringSelectMenuBuilder().setCustomId(makeCustomId("open", "", 0, String(current))).setPlaceholder("セッションを選択").addOptions(slice.map((s) => ({ label: safe(s.name, 100), value: s.id.replaceAll("-", ""), description: `${s.members.filter((m) => !m.removedAt).length}人 · ${s.expenses.length}件` })));
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu));
  }
  rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
    button("新規作成", makeCustomId("new"), ButtonStyle.Primary),
    button("前へ", makeCustomId("page", "", 0, `${Math.max(0, current - 1)}_prev`)).setDisabled(current === 0),
    button("次へ", makeCustomId("page", "", 0, `${Math.min(pages - 1, current + 1)}_next`)).setDisabled(current >= pages - 1),
  ));
  return { embeds: [embed], components: rows };
}

export function sessionDetailView(s: SessionDto, actor = "") {
  const active = s.members.filter((member) => member.removedAt === null);
  const embed = new EmbedBuilder().setTitle(safe(s.name, 256)).setDescription(`状態: ${s.status === "ACTIVE" ? "進行中" : s.status === "SETTLING" ? "精算中" : "完了"}\n参加者 ${active.length}人 · 支出 ${s.expenses.length}件\n作成者 <@${s.creatorDiscordUserId}>`).setFooter({ text: `更新番号 ${s.revision}` });
  const rows: ActionRowBuilder<any>[] = [];
  rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(button("参加者", id("members", s)), button("支出", id("expenses", s)), ...(s.status === "ACTIVE" ? [button("支出を追加", id("draft", s, "new"), ButtonStyle.Success)] : [])));
  if (s.status === "ACTIVE") rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(button("精算プレビュー", id("preview", s), ButtonStyle.Primary)));
  if (s.status !== "ACTIVE") rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(button("精算結果", id("settlement", s, ""), ButtonStyle.Primary), ...(s.status === "SETTLING" ? [button("リマインド", id("reminder", s), ButtonStyle.Secondary)] : [])));
  if (s.status === "ACTIVE" && s.creatorDiscordUserId === actor) rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(button("参加者設定", id("settings", s)), button("セッション名変更", id("rename", s)), button("戻る", makeCustomId("list"))));
  else rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(button("戻る", makeCustomId("list"))));
  return { embeds: [embed], components: rows };
}

export function memberView(s: SessionDto, page: number, actor = "") {
  const active = s.members.filter((m) => !m.removedAt);
  const pages = Math.max(1, Math.ceil(active.length / 10));
  const current = Math.min(page, pages - 1);
  const rows: ActionRowBuilder<any>[] = [];
  rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(button("前へ", id("mpage", s, `${Math.max(0, current - 1)}_prev`)).setDisabled(current === 0), button("次へ", id("mpage", s, `${Math.min(pages - 1, current + 1)}_next`)).setDisabled(current >= pages - 1), button("詳細へ戻る", id("page", s, "0"))));
  if (s.creatorDiscordUserId === actor && s.status === "ACTIVE") {
    rows.push(new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(new UserSelectMenuBuilder().setCustomId(id("add", s)).setPlaceholder("参加者を追加（最大25人）").setMinValues(1).setMaxValues(25)));
    if (active.length) rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId(id("remove", s)).setPlaceholder("削除する参加者").addOptions(active.slice(current * 10, current * 10 + 10).map((m) => ({ label: m.discordUserId, value: m.id, description: `重み ${m.weight} · 調整 ${m.fixedAdjustment}` })))));
  }
  return { embeds: [new EmbedBuilder().setTitle(`参加者 (${active.length})`).setDescription(active.slice(current * 10, current * 10 + 10).map((m) => `<@${m.discordUserId}> · 重み ${m.weight} · 調整 ${m.fixedAdjustment}`).join("\n") || "参加者はいません")], components: rows };
}

export function expenseListView(s: SessionDto, page: number) {
  const pages = Math.max(1, Math.ceil(s.expenses.length / 10)); const current = Math.min(page, pages - 1);
  const items = s.expenses.slice(current * 10, current * 10 + 10);
  const rows: ActionRowBuilder<any>[] = [];
  if (items.length) rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId(id("expense", s, String(current))).setPlaceholder("支出を選択").addOptions(items.map((e) => ({ label: safe(e.title, 100), value: e.id.replaceAll("-", ""), description: `${e.amount.toLocaleString()}円` })))));
  rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(button("前へ", id("epage", s, `${Math.max(0, current - 1)}_prev`)).setDisabled(current === 0), button("次へ", id("epage", s, `${Math.min(pages - 1, current + 1)}_next`)).setDisabled(current >= pages - 1), ...(s.status === "ACTIVE" ? [button("支出を追加", id("draft", s, "new"), ButtonStyle.Success)] : []), button("詳細へ戻る", id("page", s, "0"))));
  return { embeds: [new EmbedBuilder().setTitle(`支出 (${s.expenses.length})`).setDescription(items.map((e) => `**${safe(e.title)}** · ${e.amount.toLocaleString()}円`).join("\n") || "支出はありません")], components: rows };
}

export function expenseDetailView(s: SessionDto, e: ExpenseDto, actor = "") {
  const payer = s.members.find((m) => m.id === e.payerMemberId);
  const embed = new EmbedBuilder().setTitle(safe(e.title, 256)).setDescription(`${e.amount.toLocaleString()}円\n支払者 <@${payer?.discordUserId ?? ""}>\n対象 ${e.eligibleMemberIds.length}人`).setFooter({ text: `更新番号 ${s.revision}` });
  const controls = s.creatorDiscordUserId === actor && s.status === "ACTIVE" ? [button("編集", id("draft", s, e.id.replaceAll("-", "")), ButtonStyle.Primary), button("削除", id("delete", s, e.id.replaceAll("-", "")), ButtonStyle.Danger)] : [];
  const rows = [new ActionRowBuilder<ButtonBuilder>().addComponents(...controls, button("一覧へ戻る", id("expenses", s)))];
  return { embeds: [embed], components: rows };
}

export function expenseDraftView(s: SessionDto, d: ExpenseDraft) {
  const generation = d.generation.toString(36);
  const cmd = (a: string) => makeCustomId(a, s.id, s.revision, `${d.token}_${generation}`);
  const members = s.members.filter((m) => !m.removedAt);
  const pageSize = 25;
  const pages = Math.max(1, Math.ceil(members.length / pageSize));
  d.memberPage = Math.max(0, Math.min(d.memberPage, pages - 1));
  const memberPage = members.slice(d.memberPage * pageSize, (d.memberPage + 1) * pageSize);
  const options = memberPage.map((member, index) => ({
    label: `${d.memberPage * pageSize + index + 1}. ${member.discordUserId}`,
    value: member.id,
    description: d.eligible.has(member.id) ? "現在の対象" : "対象外",
  }));
  const paging = pages > 1 ? [
    button("前へ", makeCustomId("dpage", s.id, s.revision, `${d.token}_${generation}_${Math.max(0, d.memberPage - 1)}_prev`)).setDisabled(d.memberPage === 0),
    button("次へ", makeCustomId("dpage", s.id, s.revision, `${d.token}_${generation}_${Math.min(pages - 1, d.memberPage + 1)}_next`)).setDisabled(d.memberPage >= pages - 1),
  ] : [];
  const rows: ActionRowBuilder<any>[] = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(button("内容・金額を入力", cmd("fields"), ButtonStyle.Primary), button("全員を対象", cmd("all"), d.allEligible ? ButtonStyle.Success : ButtonStyle.Secondary), ...paging),
  ];
  if (options.length) {
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId(cmd("payer")).setPlaceholder("支払者を選択").setMinValues(1).setMaxValues(1).addOptions(options)));
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId(cmd("target")).setPlaceholder("対象追加").setMinValues(1).setMaxValues(options.length).addOptions(options)));
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId(cmd("untarget")).setPlaceholder("対象除外").setMinValues(1).setMaxValues(options.length).addOptions(options)));
  } else {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(button("参加者がいません", cmd("save")).setDisabled(true)));
  }
  rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(button("保存", cmd("save"), ButtonStyle.Success), button("キャンセル", cmd("cancel"), ButtonStyle.Danger)));
  const payer = members.find((m) => m.id === d.payer);
  return { embeds: [new EmbedBuilder().setTitle(d.expenseId ? "支出を編集" : "支出を追加").setDescription(`名称: ${safe(d.title || "未入力")}\n金額: ${d.amount || "未入力"}円\n支払者: ${payer ? `<@${payer.discordUserId}>` : "未選択"}\n対象: ${d.allEligible ? "全員" : `${d.eligible.size}人`}\n参加者候補: ${d.memberPage + 1}/${pages}ページ`)], components: rows };
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
    const line = `${member.discordUserId}, ${member.weight}, ${member.fixedAdjustment}`;
    if (lines.join("\n").length + line.length + 1 > 3600) break;
    lines.push(line);
  }
  const values = lines.join("\n") || "0, 1, 0";
  return new ModalBuilder().setCustomId(customId).setTitle("参加者の負担設定").addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("settings").setLabel("ユーザーID, Weight, 固定調整額（他の人は変更なし）").setStyle(TextInputStyle.Paragraph).setMaxLength(4000).setValue(values).setRequired(true)));
}

export function renameSessionModal(customId: string, name: string): ModalBuilder {
  return new ModalBuilder().setCustomId(customId).setTitle("セッション名変更").addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("name").setLabel("セッション名").setStyle(TextInputStyle.Short).setMaxLength(80).setValue(name).setRequired(true)),
  );
}
