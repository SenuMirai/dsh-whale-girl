;(()=>{

//#region src/shared/pickers.ts
const pick = (pool, exclude) => {
	const entries = exclude ? pool.filter((n) => n !== exclude) : pool;
	const src = entries.length ? entries : pool;
	return src[Math.floor(Math.random() * src.length)];
};
const pickSlot = (slot, exclude) => {
	if (typeof slot === "string") return slot;
	const entries = exclude === void 0 ? slot : slot.filter((n) => n !== exclude);
	const src = entries.length ? entries : slot;
	return src[Math.floor(Math.random() * src.length)];
};
const slotIncludes = (slot, anim) => typeof slot === "string" ? slot === anim : slot.includes(anim);
const poolIncludes = (pool, anim) => pool.some((slot) => slotIncludes(slot, anim));
const isEventAnim = (events, anim) => events ? Object.values(events).some((pool) => poolIncludes(pool, anim)) : false;
const nextWorkStatusAnim = (pool, current) => {
	const idx = pool.findIndex((slot$1) => slotIncludes(slot$1, current));
	if (idx === -1) return null;
	const slot = pool[idx];
	if (!Array.isArray(slot) || slot.length <= 1) return null;
	return pickSlot(slot, current);
};
const randomBetween = (min, max) => Math.floor(min + Math.random() * (max - min));
const pickWeightedCategory = (categories, facing) => {
	const cats = categories.filter((c) => c.actions.length > 0);
	if (!cats.length) return null;
	const filtered = cats.filter((c) => !(c.noMirror && facing === "right"));
	const eligible = filtered.length ? filtered : cats;
	const totalW = eligible.reduce((s, c) => s + c.weight, 0) || 1;
	let t = Math.random() * totalW;
	for (const c of eligible) {
		t -= c.weight;
		if (t <= 0) return c;
	}
	return eligible[eligible.length - 1];
};
const rollKind = (roll, w, opts) => {
	const turn = opts?.fixed ? 0 : w.turn;
	const move = opts?.fixed ? 0 : w.move;
	const topEnd = (w.idle + turn + move) / 100;
	if (roll < w.idle / 100) return "idle";
	if (roll < (w.idle + turn) / 100) return "turn";
	if (roll < topEnd) return "move";
	return "action";
};
const pickCategoryAction = (categories, idlePool, facing, current) => {
	const cat = pickWeightedCategory(categories, facing);
	if (!cat) return {
		id: "FALLBACK",
		name: pick(idlePool, current)
	};
	return {
		id: cat.id,
		name: pick(cat.actions, current)
	};
};

//#endregion
//#region src/shared/displays.ts
const rectRight = (r) => r.x + r.width;
const rectBottom = (r) => r.y + r.height;
const pointInRect = (r, x, y) => x >= r.x && x < rectRight(r) && y >= r.y && y < rectBottom(r);
const rectAtPoint = (rects, x, y) => {
	for (const r of rects) if (pointInRect(r, x, y)) return r;
	return null;
};

//#endregion
//#region src/shared/motion.ts
const planMove = (o) => {
	const side = o.sideAllow ?? 0;
	const distance = randomBetween(o.minDist, o.maxDist);
	const target = o.cx + o.dir * distance;
	if (o.areas && o.areas.length > 0) {
		const bodyHalf = o.halfW - side;
		if (!rectAtPoint(o.areas, target - bodyHalf - o.margin, o.cy)) return null;
		if (!rectAtPoint(o.areas, target + bodyHalf + o.margin, o.cy)) return null;
	} else {
		const leftBound = o.margin + o.halfW - side;
		const rightBound = o.W - o.margin - o.halfW + side;
		if (target < leftBound || target > rightBound) return null;
	}
	return {
		startRatio: o.cx / o.W,
		startYRatio: o.cy / o.H,
		targetRatio: target / o.W,
		totalRatio: Math.abs(target - o.cx) / o.W
	};
};

//#endregion
//#region src/shared/config.ts
const PET_DISPLAYS = [
	"web",
	"desktop",
	"both",
	"none"
];
const isWebVisible = (display) => display === "web" || display === "both";
function flattenConfigPets(merged) {
	const out = [];
	for (const [entry, conf] of Object.entries(merged)) {
		const list = Array.isArray(conf?.pets) ? conf.pets : [];
		for (const p of list) out.push({
			...p,
			animations: conf.animations,
			animationWeights: conf.animationWeights,
			eventsRefreshSec: conf.eventsRefreshSec,
			physics: conf.physics,
			font: conf.font,
			confineToScreen: conf.confineToScreen,
			workStatusTexts: conf.workStatusTexts,
			whisperModel: conf.whisperModel,
			chatModel: conf.chatModel,
			assetRoot: entry,
			extra: entry !== "main"
		});
	}
	return out;
}

//#endregion
//#region src/shared/balance.ts
/**
* 可选数字：缺省 → undefined；出现但非法 → null（调用方据此整拍跳过——不把 NaN/字符串送进展示层）。
*/
function optNum(value) {
	if (value === void 0 || value === null) return void 0;
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
}
function toBalanceState(raw) {
	if (!raw || typeof raw !== "object") return null;
	const r = raw;
	const provider = String(r.provider ?? "unknown");
	if (r.ok !== true) {
		const reason = r.reason === "unsupported" || r.reason === "credential-missing" || r.reason === "fetch-error" ? r.reason : "fetch-error";
		return {
			provider,
			ok: false,
			reason,
			message: typeof r.message === "string" ? r.message : void 0
		};
	}
	const d = r.data;
	if (!d || typeof d !== "object") return null;
	if (r.shape === "windows") {
		const monthly = optNum(d.monthly);
		const rolling = optNum(d.rolling);
		const weekly = optNum(d.weekly);
		const rollingCapUsd = optNum(d.rollingCapUsd);
		const weeklyCapUsd = optNum(d.weeklyCapUsd);
		const monthlyCapUsd = optNum(d.monthlyCapUsd);
		if (monthly === void 0 || monthly === null) return null;
		if (rolling === null || weekly === null || rollingCapUsd === null || weeklyCapUsd === null || monthlyCapUsd === null) return null;
		return {
			provider,
			shape: "windows",
			ok: true,
			rolling,
			weekly,
			monthly,
			rollingCapUsd,
			weeklyCapUsd,
			monthlyCapUsd,
			rollingLabel: typeof d.rollingLabel === "string" && d.rollingLabel.length > 0 ? d.rollingLabel : void 0,
			rollingResetsAt: typeof d.rollingResetsAt === "string" ? d.rollingResetsAt : void 0,
			weeklyResetsAt: typeof d.weeklyResetsAt === "string" ? d.weeklyResetsAt : void 0,
			monthlyResetsAt: typeof d.monthlyResetsAt === "string" ? d.monthlyResetsAt : void 0
		};
	}
	if (r.shape === "money") return {
		provider,
		shape: "money",
		ok: true,
		currency: typeof d.currency === "string" ? d.currency : void 0,
		total: typeof d.total === "string" ? d.total : void 0,
		granted: typeof d.granted === "string" ? d.granted : void 0,
		toppedUp: typeof d.toppedUp === "string" ? d.toppedUp : void 0,
		fullBalance: typeof d.fullBalance === "string" ? d.fullBalance : void 0,
		tier: d.tier === "peak" || d.tier === "idle" ? d.tier : void 0,
		fallbackFrom: typeof d.fallbackFrom === "string" && d.fallbackFrom.length > 0 ? d.fallbackFrom : void 0
	};
	return null;
}
function balancePercent(v) {
	if (v.shape === "money") {
		const total = Number(v.total);
		const full = Number(v.fullBalance);
		if (!Number.isFinite(total)) return void 0;
		if (!Number.isFinite(full) || full <= 0) return void 0;
		const remaining = Math.max(0, total) / full * 100;
		return Math.max(0, Math.min(100, 100 - remaining));
	}
	return Math.max(v.rolling ?? 0, v.weekly ?? 0, v.monthly ?? 0);
}
function balanceEventIndex(p) {
	if (p === 100) return 5;
	const i = Math.floor(p / 20);
	return i < 5 ? i : 4;
}
const WINDOW_LABELS = {
	weekly: "周",
	monthly: "月"
};
const DEFAULT_ROLLING_LABEL = "5h";
/** 窗口展示名：滚动窗取服务商自报值（缺省 5h），周/月走固定表 */
function windowLabel(v, w) {
	if (w === "rolling") return v.rollingLabel ?? DEFAULT_ROLLING_LABEL;
	return WINDOW_LABELS[w];
}
/** 各窗口的满额度（USD）：全部来自数据（展示层不写死任何服务商的额度） */
function windowQuotas(v) {
	return {
		rolling: v.rollingCapUsd,
		weekly: v.weeklyCapUsd,
		monthly: v.monthlyCapUsd
	};
}
function urgentWindow(v) {
	if (v.shape === "money") return void 0;
	const quotas = windowQuotas(v);
	const resets = {
		rolling: v.rollingResetsAt,
		weekly: v.weeklyResetsAt,
		monthly: v.monthlyResetsAt
	};
	const present = [
		"rolling",
		"weekly",
		"monthly"
	].filter((w) => v[w] !== void 0);
	if (present.length === 0) return void 0;
	const allQuotas = present.every((w) => {
		const quota = quotas[w];
		return quota !== void 0 && quota > 0;
	});
	let best;
	for (const w of present) {
		const percent = v[w] ?? 0;
		const quota = quotas[w];
		const cand = {
			label: windowLabel(v, w),
			percent,
			quotaUsd: quota,
			remainingUsd: allQuotas && quota !== void 0 ? quota * (100 - percent) / 100 : void 0,
			resetsAt: resets[w]
		};
		if (best === void 0) {
			best = cand;
			continue;
		}
		const moreUrgent = allQuotas ? (cand.remainingUsd ?? 0) < (best.remainingUsd ?? 0) : cand.percent > best.percent;
		if (moreUrgent) best = cand;
	}
	return best;
}
function resetInText(iso) {
	if (!iso) return "";
	const t = new Date(iso).getTime();
	if (!Number.isFinite(t)) return "";
	const delta = t - Date.now();
	if (delta <= 0) return "已重置";
	const hoursF = delta / 36e5;
	if (hoursF >= 96) return (Math.round(hoursF / 24 * 10) / 10).toFixed(1) + " 天";
	return Math.max(.1, Math.round(hoursF * 10) / 10).toFixed(1) + " 小时";
}
/** 不可用状态的气泡行（显式说明原因，绝不伪造数字）：
*  - unsupported：服务商未登记查询接口（配置事实，不是故障）→ 报出 provider id，便于自查"当前到底是谁"
*  - credential-missing：缺凭证 → 次要行放 host 报的凭证名（不含 message 时不留空行）
*  - fetch-error：抓取失败 → 次要行放底层错误
* 次要行为空的会被剔除：空 div 在气泡里会白占一行高度。 */
function unavailableRows(state) {
	const rows = state.reason === "unsupported" ? [{
		role: "error",
		text: "当前服务商暂不支持余额查询"
	}, {
		role: "sub",
		text: "当前服务商：" + state.provider
	}] : state.reason === "credential-missing" ? [{
		role: "error",
		text: "缺少余额查询凭证"
	}, {
		role: "sub",
		text: state.message ?? ""
	}] : [{
		role: "error",
		text: "余额查询失败"
	}, {
		role: "sub",
		text: state.message ?? ""
	}];
	return rows.filter((r) => r.text !== "");
}
function balanceBubbleView(state) {
	if (state.ok) {
		if (state.shape !== "money") {
			const w = urgentWindow(state);
			if (w) {
				const reset = resetInText(w.resetsAt);
				const rows$1 = [{
					role: "label",
					text: w.label + "额度已用 " + Math.round(w.percent) + "%"
				}, {
					role: "sub",
					text: reset ? reset + "重置" : "已重置"
				}];
				return rows$1;
			}
			return [{
				role: "label",
				text: "额度数据不可用"
			}];
		}
		const symbol = state.currency === "USD" ? "$" : "¥";
		const amount = symbol + (state.total ?? "-");
		const note = state.fallbackFrom === void 0 ? void 0 : {
			role: "sub",
			text: "DSH 账号余额"
		};
		const rows = !state.tier ? [{
			role: "label",
			text: "余额 " + amount
		}] : [
			{
				role: "label",
				text: "余额（"
			},
			{
				role: "tier",
				tier: state.tier,
				text: state.tier === "peak" ? "峰" : "谷"
			},
			{
				role: "label",
				text: "）" + amount
			}
		];
		if (note !== void 0) rows.push(note);
		return rows;
	}
	return unavailableRows(state);
}
function decideBalanceNotice(state, lastKey, explicit) {
	if (state.ok) return {
		show: false,
		key: null
	};
	const key = state.reason + ":" + state.provider;
	return {
		show: explicit || key !== lastKey,
		key
	};
}

//#endregion
//#region src/shared/work-status.ts
const WORK_STATUS_STATES = [
	"thinking",
	"working",
	"result",
	"waiting",
	"success",
	"error"
];
const WORK_STATUS_INDEX = {
	thinking: 0,
	working: 1,
	result: 2,
	waiting: 3,
	success: 4,
	error: 5
};
function toWorkStatus(raw) {
	if (!raw || typeof raw !== "object") return null;
	const r = raw;
	const state = r.state === null || typeof r.state === "string" && WORK_STATUS_STATES.includes(r.state) ? r.state : null;
	return {
		state,
		task: typeof r.task === "string" ? r.task : null
	};
}

//#endregion
//#region src/shared/state.ts
/** 叶子规范化：形状不对（非对象 / counter 非数字）→ null（丢弃，不让脏数据进渲染层） */
function normLeaf(value) {
	if (!value || typeof value !== "object") return null;
	const leaf$1 = value;
	if (typeof leaf$1.counter !== "number" || !Number.isFinite(leaf$1.counter)) return null;
	return {
		counter: leaf$1.counter,
		data: leaf$1.data ?? null
	};
}
async function fetchState(baseUrl = "/dsh-whale-girl/state") {
	try {
		const res = await fetch(baseUrl, { cache: "no-store" });
		if (!res.ok) return null;
		const raw = await res.json().catch(() => null);
		if (!raw || typeof raw !== "object") return null;
		const sections = {};
		const rawSections = raw.sections && typeof raw.sections === "object" ? raw.sections : {};
		for (const [name, value] of Object.entries(rawSections)) {
			const leaf$1 = normLeaf(value);
			if (leaf$1) sections[name] = leaf$1;
		}
		const pets = {};
		const rawPets = raw.pets && typeof raw.pets === "object" ? raw.pets : {};
		for (const [petId, entry] of Object.entries(rawPets)) {
			if (!entry || typeof entry !== "object") continue;
			const leaves = {};
			for (const [name, value] of Object.entries(entry)) {
				const leaf$1 = normLeaf(value);
				if (leaf$1) leaves[name] = leaf$1;
			}
			pets[petId] = leaves;
		}
		return {
			sections,
			pets,
			configVersion: typeof raw.configVersion === "string" ? raw.configVersion : void 0
		};
	} catch {
		return null;
	}
}
/** 遍历 S 的所有叶子（顺序：sections 在前、pets 在后） */
function* walkLeaves(s) {
	for (const [name, leaf$1] of Object.entries(s.sections ?? {})) yield ["sections." + name, leaf$1];
	for (const [petId, leaves] of Object.entries(s.pets ?? {})) for (const [name, leaf$1] of Object.entries(leaves ?? {})) yield ["pets." + petId + "." + name, leaf$1];
}
function flattenCounters(s) {
	const out = {};
	for (const [path, leaf$1] of walkLeaves(s)) out[path] = leaf$1.counter;
	return out;
}
function takeChanged(s, baseline) {
	const out = [];
	for (const [path, leaf$1] of walkLeaves(s)) {
		if (baseline[path] === leaf$1.counter) continue;
		baseline[path] = leaf$1.counter;
		out.push({
			path,
			leaf: leaf$1
		});
	}
	return out;
}
function readBalance(leaf$1) {
	const state = toBalanceState(leaf$1.data);
	if (!state) return null;
	const manual = leaf$1.data.manual === true;
	return {
		state,
		manual
	};
}
function readSay(leaf$1) {
	if (!leaf$1.data || typeof leaf$1.data !== "object") return null;
	const d = leaf$1.data;
	if (typeof d.text !== "string" || !d.text) return null;
	return {
		text: d.text,
		image: typeof d.image === "string" ? d.image : void 0,
		speak: d.speak === true
	};
}
function readWorkStatus(leaf$1) {
	return toWorkStatus(leaf$1.data);
}
function readAnim(leaf$1) {
	if (!leaf$1.data || typeof leaf$1.data !== "object") return null;
	const d = leaf$1.data;
	if (typeof d.name !== "string" || !d.name) return null;
	return { name: d.name };
}
async function postAction(baseUrl, body) {
	try {
		const res = await fetch(baseUrl, {
			method: "POST",
			...body === void 0 ? {} : {
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body)
			}
		});
		if (!res.ok) return false;
		const data = await res.json().catch(() => null);
		return data?.ok === true;
	} catch {
		return false;
	}
}

//#endregion
//#region src/shared/whisper.ts
function whisperBubbleView(state) {
	if (state.ok) return [{
		role: "label",
		text: state.text
	}];
	const msg = state.reason === "provider-missing" ? "当前对话未配置模型，碎碎念不可用" : "碎碎念生成失败" + (state.message ? "：" + state.message : "");
	return [{
		role: "label",
		text: msg
	}];
}
function memeImageUrl(name, base = "/dsh-whale-girl", assetRoot = "") {
	const root = String(assetRoot ?? "").trim();
	const prefix = root ? "/pic/memes/" + encodeURIComponent(root) : "/pic/memes";
	return base + prefix + "/" + encodeURIComponent(name) + ".png";
}
const MEME_IMG_CLASS = "pet-bub-img";
const MEME_BUBBLE_CLASS = "has-img";
const MEME_BUBBLE_CSS = [".pet-bub-img{--m:var(--f,calc(var(--dsh-whale-girl-size,var(--pet-size,462px))*0.0455));display:block;width:calc(var(--m)*7.4725);max-width:100%;height:auto;border-radius:calc(var(--m)*0.5714);margin:0 auto calc(var(--m)*0.3736);object-fit:cover;pointer-events:none;user-select:none}", ".pet-bubble.has-img,.dsh-whale-girl-bubble.has-img{min-width:0}"].join("");
/** 只注入一次（两端共用；页面已有同一标记则跳过） */
let memeCssInjected = false;
function injectMemeBubbleCss() {
	if (memeCssInjected || typeof document === "undefined") return;
	memeCssInjected = true;
	if (document.querySelector("style[data-plugin-css=\"dsh-whale-girl/meme-bubble\"]") !== null) return;
	const tag = document.createElement("style");
	tag.dataset.plugin = "dsh-whale-girl";
	tag.dataset.pluginCss = "dsh-whale-girl/meme-bubble";
	tag.textContent = MEME_BUBBLE_CSS;
	document.head.appendChild(tag);
}

//#endregion
//#region src/client/bubble.ts
/** 气泡内联样式：白色半透明圆润泡 + 底部小尾巴指向宠物；字体用上首软糖体（本地打包，稳定）。
* 尺寸分两类锚点：
*  - 气泡**盒子**（宽上下限/内边距/圆角/尾巴/阴影/行间距/角标）锚在字号 `--f` 上（em 语义）：
*    字号调大盒子同步变大，文字永远装得下——不再出现「字长大了、框没长」把文字顶出白底；
*  - 气泡**位置**（bottom 偏移）仍锚在 `--dsh-whale-girl-size`，保证气泡始终贴在宠物头顶同一点。
* 系数 = 原系数 ÷ 0.0455（原字号系数），故默认 462px 宠物 / 21px 字号下与改造前逐像素一致：
* ×0.0455 → 1em、最小宽 0.26 → 5.7143、最大宽 0.5 → 10.989 等。
* 字号：正文取 --dsh-whale-girl-font-bubble（两端按该宠物尺寸算好注入，见 shared/fonts.ts 的 resolveFontPx）；
* 气泡内其余层级按「相对正文的比例」派生——故统一先定义局部变量 --f = 正文最终字号，
* 子元素经自定义属性继承取用；变量未注入时 --f 回退到原表达式，行为与改造前逐像素一致。
* 换行：正文不锁 nowrap，折行只在内容真的超过宽度上限时才发生（见下一条）。
* 宽度为什么必须写 width:max-content：气泡是 left:50% 的绝对定位盒，它的「可用宽度」只有包含块的一半
* （= 宠物宽度的一半），shrink-to-fit 会先被这道墙卡死——max-width 调多大都不生效，字号一大就折行/顶出。
* 写 width:max-content 后盒子先按内容取宽，再由 max-width 收口（= min(字号口径上限, 包含块 100%)），
* 「字变大 → 框变宽」才真正生效，且永不超过宠物本身宽度（桌面窗口只比宠物大一圈，超了会被裁）。
* 断词用 break-word 而非 anywhere：只在整词放不下时才断，不会把 85% / ¥12.34 这类数字拆到两行。 */
const bubbleCss = [
	"@font-face{font-family:\"ShangshouSoftCandy\";src:url(\"/dsh-whale-girl/font/上首软糖体.ttf\") format(\"truetype\");font-display:swap;font-weight:400}",
	".dsh-whale-girl-bubble{position:absolute;left:50%;transform:translateX(-50%);bottom:calc(100% - var(--dsh-whale-girl-size)*0.108);width:max-content;min-width:calc(var(--f)*5.7143);max-width:min(calc(var(--f)*10.989),100%);box-sizing:content-box;padding:calc(var(--f)*0.4835) calc(var(--f)*0.6593);border-radius:calc(var(--f)*0.7692);background:rgba(255,255,255,.92);--f:var(--dsh-whale-girl-font-bubble,calc(var(--dsh-whale-girl-size)*0.0455));color:#2b2b2b;font-family:var(--dsh-whale-girl-font-family,\"ShangshouSoftCandy\",\"Yuanti SC\",\"YouYuan\",\"幼圆\",\"Comic Sans MS\",\"PingFang SC\",\"Microsoft YaHei\",sans-serif);font-size:var(--f);line-height:1.6;z-index:3;pointer-events:none;box-shadow:0 calc(var(--f)*0.1978) calc(var(--f)*0.7692) rgba(0,0,0,.14),0 1px 3px rgba(0,0,0,.08);backdrop-filter:blur(6px);opacity:0;transition:opacity .25s ease;white-space:normal;overflow-wrap:break-word}",
	".dsh-whale-girl-bubble::after{content:\"\";position:absolute;left:50%;bottom:calc(var(--f)*-0.3736);transform:translateX(-50%);border:calc(var(--f)*0.3736) solid transparent;border-top-color:rgba(255,255,255,.92);border-bottom:none}",
	".dsh-whale-girl-bubble.is-on{opacity:1}",
	".dsh-whale-girl-bubble.dsh-whale-girl-whisper{font-size:calc(var(--f)*0.7473);min-width:calc(var(--f)*2.1978);max-width:min(calc(var(--f)*10.989),100%)}",
	".dsh-whale-girl-bubble .pet-bub-title{font-size:calc(var(--f)*0.7692);color:rgba(43,43,43,.6);margin-bottom:calc(var(--f)*0.1978)}",
	".dsh-whale-girl-bubble .pet-bub-row{display:flex;justify-content:space-between;gap:calc(var(--f)*0.6593)}",
	".dsh-whale-girl-bubble .pet-bub-sub{font-size:calc(var(--f)*0.7692);color:rgba(43,43,43,.6)}",
	".dsh-whale-girl-bubble .pet-bub-val{font-variant-numeric:tabular-nums;font-weight:650;color:#1f1f1f}",
	".dsh-whale-girl-bubble .pet-bub-err{color:#d94f3d;font-size:calc(var(--f)*0.7692)}",
	".dsh-whale-girl-bubble .pet-bub-tag{margin-left:calc(var(--f)*0.2857);font-size:calc(var(--f)*0.4835);color:rgba(43,43,43,.55);border:1px solid rgba(43,43,43,.25);border-radius:calc(var(--f)*0.2857);padding:0 calc(var(--f)*0.1978);vertical-align:1px}",
	".dsh-whale-girl-bubble .pet-bub-tier{font-weight:700}",
	".dsh-whale-girl-bubble .pet-bub-tier-peak{color:#e53935}",
	".dsh-whale-girl-bubble .pet-bub-tier-idle{color:#2e9e4f}"
].join("\n");
/** 只注入一次 */
function injectBubbleCss() {
	if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=\"dsh-whale-girl/bubble\"]") === null) {
		const tag = document.createElement("style");
		tag.dataset.plugin = "dsh-whale-girl";
		tag.dataset.pluginCss = "dsh-whale-girl/bubble";
		tag.textContent = bubbleCss;
		document.head.appendChild(tag);
	}
}
/** 行数据 → React 节点（shared 视图的薄壳） */
function rowsToNodes(h, rows) {
	const block = (r, key) => {
		if (r.role === "error") return h("div", {
			key,
			className: "pet-bub-err",
			children: r.text
		});
		if (r.role === "sub") return h("div", {
			key,
			className: "pet-bub-row pet-bub-sub",
			children: r.text
		});
		return h("div", {
			key,
			className: "pet-bub-row",
			children: r.text
		});
	};
	const tierIndex = rows.findIndex((r) => r.role === "tier");
	if (tierIndex >= 0) {
		const firstBlockAfterTier = rows.findIndex((r, i) => i > tierIndex && (r.role === "sub" || r.role === "error"));
		const splitAt = firstBlockAfterTier < 0 ? rows.length : firstBlockAfterTier;
		const head = rows.slice(0, splitAt);
		const tail = rows.slice(splitAt);
		return [h("div", {
			key: "tier-line",
			className: "pet-bub-row",
			children: head.map((r, i) => r.role === "tier" ? h("span", {
				key: i,
				className: "pet-bub-tier pet-bub-tier-" + r.tier,
				children: r.text
			}) : h("span", {
				key: i,
				children: r.text
			}))
		}), ...tail.map((r, i) => block(r, i))];
	}
	return rows.map((r, i) => block(r, i));
}
function makeBalanceBubble(rt) {
	const { h } = rt;
	injectBubbleCss();
	return function BalanceBubble({ state, on }) {
		const rows = balanceBubbleView(state);
		const wrap = state.ok ? "" : " dsh-whale-girl-whisper";
		return h("div", {
			className: "dsh-whale-girl-bubble" + wrap + (on ? " is-on" : ""),
			children: rowsToNodes(h, rows)
		});
	};
}
function makeWhisperBubble(rt) {
	const { h } = rt;
	injectBubbleCss();
	injectMemeBubbleCss();
	return function WhisperBubble({ text, image, assetRoot, on }) {
		const rows = whisperBubbleView({
			ok: true,
			text,
			ts: 0
		});
		const key = String(image ?? "").trim();
		return h("div", {
			className: "dsh-whale-girl-bubble dsh-whale-girl-whisper" + (key ? " " + MEME_BUBBLE_CLASS : "") + (on ? " is-on" : ""),
			children: key ? [h("img", {
				key: "img",
				className: MEME_IMG_CLASS,
				src: memeImageUrl(key, "/dsh-whale-girl", assetRoot),
				alt: key
			}), rowsToNodes(h, rows)] : rowsToNodes(h, rows)
		});
	};
}

//#endregion
//#region src/shared/constants.ts
const CANVAS_H = 360;
const FEET_Y = 330;
const HIT_BOX = {
	x0: 200,
	y0: 50,
	x1: 440,
	y1: 335
};
const DRAG_THRESHOLD = 5;
const PET_REF_WIDTH = 462;
const ANIMATION_EXT = ".webm";

//#endregion
//#region src/shared/score.ts
const SCORE_MIN_SPEED = 400;
/** 每 100 px/s 记 1 分（基准尺寸 462px 下） */
const SCORE_SPEED_PER_POINT = 100;
const clickScore = (speed, size) => {
	if (speed <= 0 || size <= 0) return 0;
	return Math.max(1, Math.round(speed / SCORE_SPEED_PER_POINT * (PET_REF_WIDTH / size)));
};

//#endregion
//#region src/shared/score-popup.ts
const SCORE_POPUP_DURATION_MS = 2200;
const SCORE_POPUP_CSS = [
	".dsh-whale-girl-score{position:fixed;z-index:2147483002;min-width:120px;text-align:center;",
	"background:rgba(255,255,255,.97);border:1px solid rgba(255,179,0,.35);border-radius:12px;",
	"box-shadow:0 10px 32px rgba(0,0,0,.22);padding:8px 16px 9px;user-select:none;pointer-events:auto;",
	"font-family:var(--dsh-whale-girl-font-family,'ShangshouSoftCandy','Yuanti SC','YouYuan','幼圆','Comic Sans MS','PingFang SC','Microsoft YaHei',sans-serif);}",
	".dsh-whale-girl-score.is-in{animation:dshPetScorePop .28s ease}",
	".dsh-whale-girl-score-val{font-size:22px;line-height:1.25;font-weight:700;color:#ff8f00;font-variant-numeric:tabular-nums}",
	".dsh-whale-girl-score-sub{font-size:11px;line-height:1.4;color:rgba(43,43,43,.6);margin-top:2px;white-space:nowrap}",
	".dsh-whale-girl-score-burst{position:fixed;inset:0;pointer-events:none;z-index:2147483002}",
	".dsh-whale-girl-score-particle{position:absolute;border-radius:50%;pointer-events:none}",
	"@keyframes dshPetScorePop{from{transform:scale(.6);opacity:0}to{transform:scale(1);opacity:1}}"
].join("");
/** 粒子只注入一次（同 CHAT_CSS 的 injectChatCss 模式） */
let scoreCssInjected = false;
function injectScoreCss() {
	if (scoreCssInjected || typeof document === "undefined") return;
	scoreCssInjected = true;
	const tag = document.createElement("style");
	tag.dataset.plugin = "dsh-whale-girl";
	tag.dataset.pluginCss = "dsh-whale-girl/score";
	tag.textContent = SCORE_POPUP_CSS;
	document.head.appendChild(tag);
}
/** 粒子数量 */
const BURST_COUNT = 20;
/** 初速范围（px/s） */
const BURST_SPEED_MIN = 120;
const BURST_SPEED_MAX = 460;
/** 重力（px/s²）：粒子向上喷出后回落 */
const BURST_GRAVITY = 700;
/** 单粒子寿命范围（ms） */
const BURST_LIFE_MIN = 500;
const BURST_LIFE_MAX = 900;
/** 粒子半径范围（px） */
const BURST_RADIUS_MIN = 3;
const BURST_RADIUS_MAX = 7;
/** 暖色盘（积分/庆祝感） */
const BURST_COLORS = [
	"#ffb300",
	"#ff8f00",
	"#ff7043",
	"#f4511e",
	"#ffc400",
	"#ffd54f",
	"#ef5350"
];
function spawnScoreBurst(x, y) {
	if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
	injectScoreCss();
	const root = document.createElement("div");
	root.className = "dsh-whale-girl-score-burst";
	document.body.appendChild(root);
	const parts = [];
	for (let i = 0; i < BURST_COUNT; i++) {
		const angle = Math.random() * Math.PI * 2;
		const speed = BURST_SPEED_MIN + Math.random() * (BURST_SPEED_MAX - BURST_SPEED_MIN);
		const r = BURST_RADIUS_MIN + Math.random() * (BURST_RADIUS_MAX - BURST_RADIUS_MIN);
		const el = document.createElement("div");
		el.className = "dsh-whale-girl-score-particle";
		el.style.left = x + "px";
		el.style.top = y + "px";
		el.style.width = r * 2 + "px";
		el.style.height = r * 2 + "px";
		el.style.background = BURST_COLORS[Math.floor(Math.random() * BURST_COLORS.length)];
		root.appendChild(el);
		parts.push({
			el,
			vx: Math.cos(angle) * speed,
			vy: Math.sin(angle) * speed - 80,
			t0: performance.now(),
			life: BURST_LIFE_MIN + Math.random() * (BURST_LIFE_MAX - BURST_LIFE_MIN)
		});
	}
	const step = () => {
		const now = performance.now();
		let alive = false;
		for (const p of parts) {
			const tSec = (now - p.t0) / 1e3;
			const lifeRatio = (now - p.t0) / p.life;
			if (lifeRatio >= 1) continue;
			alive = true;
			p.el.style.transform = "translate(" + p.vx * tSec + "px," + (p.vy * tSec + .5 * BURST_GRAVITY * tSec * tSec) + "px)";
			p.el.style.opacity = String(Math.max(0, 1 - lifeRatio));
		}
		if (alive) requestAnimationFrame(step);
		else root.remove();
	};
	requestAnimationFrame(step);
}
function mountScorePopup(opts) {
	injectScoreCss();
	const x = opts.x;
	const y = opts.y;
	const root = document.createElement("div");
	root.className = "dsh-whale-girl-score";
	const val = document.createElement("div");
	val.className = "dsh-whale-girl-score-val";
	val.textContent = "+" + opts.score;
	const sub = document.createElement("div");
	sub.className = "dsh-whale-girl-score-sub";
	sub.textContent = "速度 " + Math.round(opts.speed) + " · 大小 " + Math.round(opts.size);
	root.appendChild(val);
	root.appendChild(sub);
	document.body.appendChild(root);
	const rr = root.getBoundingClientRect();
	root.style.left = Math.max(4, Math.min(x - rr.width / 2, window.innerWidth - rr.width - 4)) + "px";
	root.style.top = Math.max(4, y - rr.height - 14) + "px";
	root.offsetWidth;
	root.classList.add("is-in");
	let closed = false;
	let timer = null;
	const close = () => {
		if (closed) return;
		closed = true;
		if (timer !== null) window.clearTimeout(timer);
		timer = null;
		document.removeEventListener("mousedown", onDocPointerDown, true);
		document.removeEventListener("keydown", onDocKeyDown, true);
		root.remove();
		if (opts.onClose) opts.onClose();
	};
	const mountedAt = performance.now();
	let graceConsumed = false;
	const onDocPointerDown = (e) => {
		if (closed) return;
		if (!graceConsumed) {
			graceConsumed = true;
			if (e.timeStamp - mountedAt < 300) return;
		}
		if (root.contains(e.target)) return;
		close();
	};
	const onDocKeyDown = (e) => {
		if (closed) return;
		if (e.key === "Escape") close();
	};
	document.addEventListener("mousedown", onDocPointerDown, true);
	document.addEventListener("keydown", onDocKeyDown, true);
	timer = window.setTimeout(close, SCORE_POPUP_DURATION_MS);
	return {
		el: root,
		close
	};
}

//#endregion
//#region src/shared/menu.ts
const displayMenuBranch = () => ({
	label: "显示位置",
	children: [
		{
			label: "仅网页",
			action: "set-display",
			display: "web"
		},
		{
			label: "仅桌面",
			action: "set-display",
			display: "desktop"
		},
		{
			label: "两者",
			action: "set-display",
			display: "both"
		},
		{
			label: "都不",
			action: "set-display",
			display: "none"
		}
	]
});
/** 事件名 → 分类标签（无映射时用事件名本身） */
const EVENT_LABELS = {
	balance: "余额档位",
	whisper: "碎碎念",
	workStatus: "工作状态"
};
const leaf = (anim) => ({
	label: anim,
	anim
});
function buildMenuTree(animations) {
	const groups = [];
	const pools = [
		["待机", animations.idle],
		["转向", animations.turn],
		["拖拽", animations.drag],
		["点击回应", animations.clicks],
		["移动", animations.moves.actions.map((m) => m.name)]
	];
	for (const [label, pool] of pools) if (pool.length) groups.push({
		label,
		children: pool.map(leaf)
	});
	const cats = (animations.categories ?? []).filter((c) => c.actions.length > 0);
	for (const c of cats) groups.push({
		label: c.id,
		children: c.actions.map(leaf)
	});
	const events = animations.events ?? {};
	for (const key of Object.keys(events)) {
		const pool = events[key] ?? [];
		const names = [];
		for (const slot of pool) if (typeof slot === "string") names.push(slot);
		else names.push(...slot);
		if (names.length) groups.push({
			label: EVENT_LABELS[key] ?? key,
			children: names.map(leaf)
		});
	}
	if (!groups.length) return [];
	return [{
		label: "动作",
		children: groups
	}];
}
function isNoMirrorAnimation(categories, anim) {
	return (categories ?? []).some((c) => c.noMirror === true && c.actions.includes(anim));
}
const MENU_CSS = [
	".dsh-whale-girl-menu{position:fixed;left:0;top:0;z-index:2147483000;color:#2b2b2b;font-size:13px;line-height:1.5;",
	"font-family:'Microsoft YaHei UI','Segoe UI','PingFang SC',sans-serif;user-select:none;pointer-events:auto}",
	".dsh-whale-girl-menu,.dsh-whale-girl-menu *{box-sizing:border-box}",
	".dsh-whale-girl-menu-column{position:absolute;min-width:150px;max-width:240px;padding:4px;",
	"background:rgba(255,255,255,.98);border:1px solid rgba(0,0,0,.12);border-radius:8px;",
	"box-shadow:0 8px 28px rgba(0,0,0,.2);max-height:min(62vh,460px);overflow-y:auto;",
	"scrollbar-width:thin;scrollbar-color:rgba(0,0,0,.22) transparent}",
	".dsh-whale-girl-menu-column::-webkit-scrollbar{width:8px;height:8px}",
	".dsh-whale-girl-menu-column::-webkit-scrollbar-track{background:transparent}",
	".dsh-whale-girl-menu-column::-webkit-scrollbar-thumb{background:rgba(0,0,0,.16);border-radius:4px;",
	"border:2px solid transparent;background-clip:content-box}",
	".dsh-whale-girl-menu-column::-webkit-scrollbar-thumb:hover{background:rgba(43,99,255,.4);",
	"border:2px solid transparent;background-clip:content-box}",
	".dsh-whale-girl-menu-column::-webkit-scrollbar-corner{background:transparent}",
	".dsh-whale-girl-menu-item{position:relative;display:flex;align-items:center;justify-content:space-between;",
	"gap:14px;padding:5px 12px;border-radius:6px;white-space:nowrap;cursor:default}",
	".dsh-whale-girl-menu-item:hover{background:rgba(43,99,255,.14)}",
	".dsh-whale-girl-menu-item>span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis}",
	".dsh-whale-girl-menu-arrow{color:#9aa0a6;font-size:12px;flex:none}"
].join("");
function isBranchNode(n) {
	return "children" in n && Array.isArray(n.children);
}
function mountContextMenu(opts) {
	const { tree, x, y, onAction, onClose, clamp } = opts;
	const c = clamp && Number.isFinite(clamp.x + clamp.y + clamp.w + clamp.h) ? clamp : {
		x: 0,
		y: 0,
		w: window.innerWidth,
		h: window.innerHeight
	};
	const root = document.createElement("div");
	root.className = "dsh-whale-girl-menu";
	root.style.left = "0px";
	root.style.top = "0px";
	root.addEventListener("contextmenu", (e) => e.preventDefault());
	let closed = false;
	/** 每个面板当前展开的子面板（无 = 未展开）；hideChain 会沿链清除 */
	const openChild = new Map();
	/** 指针整体离开菜单树的兜底关闭定时器（root mouseover 重新进入即取消） */
	let leaveTimer = null;
	/** 关闭某面板及其后代面板整条链（display:none + 清 openChild 链） */
	const hideChain = (panel) => {
		panel.style.display = "none";
		const child = openChild.get(panel);
		if (child) {
			openChild.delete(panel);
			hideChain(child);
		}
	};
	/** 把面板显示在触发项旁边：右缘展开，贴右/下边缘自动翻转夹取（在 clamp 矩形内） */
	const showPanel = (panel, item) => {
		const rect = item.getBoundingClientRect();
		panel.style.left = "";
		panel.style.top = "";
		panel.style.display = "block";
		let left = rect.right + 4;
		if (left + panel.offsetWidth > c.x + c.w - 4) left = rect.left - panel.offsetWidth - 4;
		left = Math.max(c.x + 4, left);
		let top = rect.top;
		if (top + panel.offsetHeight > c.y + c.h - 4) top = Math.max(c.y + 4, c.y + c.h - 4 - panel.offsetHeight);
		panel.style.left = left + "px";
		panel.style.top = top + "px";
	};
	/** 构建一层面板（nodes 列表）；分支项的子面板**平级**挂到 root 下，不嵌套。
	*  面板自身先入 DOM、子面板随后入 → 层级越深绘制越靠上（子菜单盖在父菜单上层）。 */
	const buildPanel = (nodes) => {
		const panel = document.createElement("div");
		panel.className = "dsh-whale-girl-menu-column";
		panel.style.display = "none";
		if (clamp) panel.style.maxHeight = Math.min(460, Math.max(120, c.h - 16)) + "px";
		root.appendChild(panel);
		for (const node of nodes) {
			const item = document.createElement("div");
			item.className = "dsh-whale-girl-menu-item";
			if (isBranchNode(node)) {
				item.classList.add("dsh-whale-girl-menu-branch");
				const label = document.createElement("span");
				label.textContent = node.label;
				const arrow = document.createElement("span");
				arrow.className = "dsh-whale-girl-menu-arrow";
				arrow.textContent = "▸";
				item.appendChild(label);
				item.appendChild(arrow);
				const childPanel = buildPanel(node.children);
				item.addEventListener("mouseenter", () => {
					const prev = openChild.get(panel);
					if (prev && prev !== childPanel) hideChain(prev);
					openChild.set(panel, childPanel);
					showPanel(childPanel, item);
				});
			} else {
				const label = document.createElement("span");
				label.textContent = node.label;
				item.appendChild(label);
				item.addEventListener("click", (e) => {
					e.preventDefault();
					e.stopPropagation();
					close();
					onAction(node);
				});
			}
			panel.appendChild(item);
		}
		return panel;
	};
	const rootPanel = buildPanel(tree);
	rootPanel.style.display = "block";
	document.body.appendChild(root);
	rootPanel.style.left = "";
	rootPanel.style.top = "";
	const rw = rootPanel.offsetWidth;
	const rh = rootPanel.offsetHeight;
	rootPanel.style.left = Math.max(c.x + 4, Math.min(x, c.x + c.w - rw - 4)) + "px";
	rootPanel.style.top = Math.max(c.y + 4, Math.min(y, c.y + c.h - rh - 4)) + "px";
	root.addEventListener("mouseleave", () => {
		if (leaveTimer !== null) window.clearTimeout(leaveTimer);
		leaveTimer = window.setTimeout(() => {
			leaveTimer = null;
			close();
		}, 200);
	});
	root.addEventListener("mouseover", () => {
		if (leaveTimer !== null) {
			window.clearTimeout(leaveTimer);
			leaveTimer = null;
		}
	});
	const onDocPointerDown = (e) => {
		if (closed) return;
		if (root.contains(e.target)) return;
		close();
	};
	const onDocKeyDown = (e) => {
		if (closed) return;
		if (e.key === "Escape") close();
	};
	document.addEventListener("mousedown", onDocPointerDown, true);
	document.addEventListener("keydown", onDocKeyDown, true);
	const close = () => {
		if (closed) return;
		closed = true;
		if (leaveTimer !== null) window.clearTimeout(leaveTimer);
		leaveTimer = null;
		document.removeEventListener("mousedown", onDocPointerDown, true);
		document.removeEventListener("keydown", onDocKeyDown, true);
		root.remove();
		if (onClose) onClose();
	};
	return {
		el: root,
		close
	};
}

//#endregion
//#region src/shared/tooltip.ts
const TOOLTIP_CLASS = "pet-tooltip";
const TOOLTIP_GAP_RATIO = .022;
function tooltipPlacement(cursor, tip, bounds, gap) {
	const clamp = (v, lo, hi) => hi < lo ? lo : Math.min(Math.max(v, lo), hi);
	const rightMax = bounds.x + bounds.w;
	const bottomMax = bounds.y + bounds.h;
	let x = cursor.x + gap;
	if (x + tip.w > rightMax) x = cursor.x - gap - tip.w;
	x = clamp(x, bounds.x, rightMax - tip.w);
	let y = cursor.y + gap;
	if (y + tip.h > bottomMax) y = cursor.y - gap - tip.h;
	y = clamp(y, bounds.y, bottomMax - tip.h);
	return {
		x,
		y
	};
}
const TOOLTIP_CSS = [
	".pet-tooltip{",
	"position:fixed;left:0;top:0;",
	"max-width:calc(var(--dsh-whale-girl-size,var(--pet-size,462px))*0.8);",
	"padding:calc(var(--dsh-whale-girl-size,var(--pet-size,462px))*0.010) calc(var(--dsh-whale-girl-size,var(--pet-size,462px))*0.021);",
	"border-radius:calc(var(--dsh-whale-girl-size,var(--pet-size,462px))*0.016);",
	"background:rgba(255,255,255,.96);color:#1f1f1f;",
	"border:1px solid rgba(0,0,0,.12);",
	"font-family:var(--dsh-whale-girl-font-family,\"ShangshouSoftCandy\",\"Yuanti SC\",\"YouYuan\",\"幼圆\",\"Comic Sans MS\",\"PingFang SC\",\"Microsoft YaHei\",sans-serif);",
	"font-size:var(--dsh-whale-girl-font-tip,calc(var(--dsh-whale-girl-size,var(--pet-size,462px))*0.026));line-height:1.4;",
	"white-space:nowrap;overflow:hidden;text-overflow:ellipsis;",
	"box-shadow:0 calc(var(--dsh-whale-girl-size,var(--pet-size,462px))*0.004) calc(var(--dsh-whale-girl-size,var(--pet-size,462px))*0.013) rgba(0,0,0,.18);",
	"opacity:0;transition:opacity .12s ease;pointer-events:none;z-index:2}",
	".pet-tooltip.is-on{opacity:1}"
].join("");

//#endregion
//#region src/shared/error-text.ts
/**
* 模型/语音失败的**人话化**（浏览器 overlay 与桌面窗共用同一份）。
*
* 为什么必须有这一层：宿主会把上游的原始错误整段塞进 `message`
* （实测有 300+ 字符的 429 JSON，还带 reset 时间戳）。原样显示会出现两种坏结果：
*   - 气泡里一坨 JSON，主人看不出是什么事（而且撑破布局）
*   - 语音按钮旁那个 nowrap 标签直接横向溢出屏幕，看起来像「什么都没发生」
*
* 这里只做「取最短可读摘要」，**不改语义**：
* 拿不准的原样截断，绝不把失败粉饰成成功。
*/
/** 已知失败原因 → 一句中文 */
const KNOWN = {
	"service-missing": "语音识别服务不可用",
	"provider-missing": "没有启用语音识别",
	"no-pet": "没有可对话的宠物",
	"bad-request": "请求参数不对"
};
function humanizeModelError(reason, message, maxLength = 36) {
	const raw = (message ?? reason ?? "未知错误").trim();
	if (raw === "") return reason !== void 0 ? KNOWN[reason] ?? reason : "未知错误";
	if (/\b429\b|soft_rate|rate.?limit|频率|quota|额度/i.test(raw)) {
		const reset = raw.match(/([0-9]{4}-[0-9]{2}-[0-9]{2})[ T]([0-9]{2}:[0-9]{2})/);
		return reset !== null ? `模型限流（${reset[1]} ${reset[2]} 恢复）` : "模型限流，稍后再试";
	}
	if (/api.?key|credential|凭据|凭证|401|403/i.test(raw)) return "缺少模型凭证（去设置里配一下）";
	if (/没听清|empty/i.test(raw)) return "没听清，再说一次";
	if (/Invalid speech WAV|canonical/i.test(raw)) return "录音格式被拒（内部错误）";
	if (/timeout|timed out|超时/i.test(raw)) return "请求超时，稍后再试";
	if (/ECONNREFUSED|ENOTFOUND|network|fetch failed/i.test(raw)) return "网络不通";
	if (KNOWN[raw] !== void 0) return KNOWN[raw];
	if (reason !== void 0 && KNOWN[reason] !== void 0) return KNOWN[reason];
	const oneLine = raw.replace(/\s+/g, " ");
	return oneLine.length > maxLength ? oneLine.slice(0, maxLength) + "…" : oneLine;
}

//#endregion
//#region src/shared/chat.ts
const SEND_TIMEOUT_MS = 6e4;
async function sendChat(baseUrl, text) {
	const res = await fetch(baseUrl, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ text }),
		signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
	});
	const raw = await res.json().catch(() => null);
	if (!raw || typeof raw !== "object") throw new Error("dsh-whale-girl: 对话响应非法");
	const o = raw;
	if (o.ok !== true) return {
		ok: false,
		reason: o.reason === "provider-missing" || o.reason === "generate-error" || o.reason === "config-error" ? o.reason : "bad-request",
		message: typeof o.message === "string" ? o.message : void 0
	};
	return { ok: true };
}
const CHAT_CSS = [
	".dsh-whale-girl-chat{position:fixed;z-index:2147483001;width:160px;max-width:80vw;",
	"background:rgba(255,255,255,.98);border:1px solid rgba(0,0,0,.12);border-radius:10px;",
	"box-shadow:0 10px 32px rgba(0,0,0,.22);color:#2b2b2b;font-size:14px;line-height:1.5;",
	"font-family:var(--dsh-whale-girl-font-family,'ShangshouSoftCandy','Yuanti SC','YouYuan','幼圆','Comic Sans MS','PingFang SC','Microsoft YaHei',sans-serif);",
	"user-select:none}",
	".dsh-whale-girl-chat *{box-sizing:border-box}",
	".dsh-whale-girl-chat-input{display:block;width:100%;border:none;outline:none;background:transparent;",
	"padding:8px 11px 9px;font-size:14px;line-height:1.45;color:#2b2b2b;font-family:inherit;",
	"resize:none;overflow:hidden;white-space:pre-wrap;overflow-wrap:anywhere}",
	".dsh-whale-girl-chat-input::placeholder{color:rgba(43,43,43,.45)}",
	".dsh-whale-girl-chat-input:disabled{opacity:.55}",
	".dsh-whale-girl-chat-err{color:#d94f3d;font-size:12px;padding:0 12px 8px;white-space:pre-wrap;overflow-wrap:anywhere}"
].join("");
/** 输入框宽度自适应参数：初始小宽 → 随文本增宽 → 封顶后折行增高 */
const CHAT_MIN_W = 160;
const CHAT_MAX_W = 340;
const CHAT_H_PAD = 22;
let chatCssInjected = false;
function injectChatCss() {
	if (chatCssInjected || typeof document === "undefined") return;
	chatCssInjected = true;
	const tag = document.createElement("style");
	tag.dataset.plugin = "dsh-whale-girl";
	tag.dataset.pluginCss = "dsh-whale-girl/chat";
	tag.textContent = CHAT_CSS;
	document.head.appendChild(tag);
}
function mountChatDialog(opts) {
	injectChatCss();
	const { petId, x, y, onSent, onClose, clamp } = opts;
	const baseUrl = opts.baseUrl ?? "/dsh-whale-girl/chat";
	const withPet = baseUrl + "?pet=" + encodeURIComponent(petId);
	const c = clamp && Number.isFinite(clamp.x + clamp.y + clamp.w + clamp.h) ? clamp : {
		x: 0,
		y: 0,
		w: window.innerWidth,
		h: window.innerHeight
	};
	const root = document.createElement("div");
	root.className = "dsh-whale-girl-chat";
	const input = document.createElement("textarea");
	input.className = "dsh-whale-girl-chat-input";
	input.placeholder = "说点什么…";
	input.maxLength = 2e3;
	input.rows = 1;
	let measureCtx = null;
	const measureText = (text) => {
		const ctx = measureCtx ?? (measureCtx = document.createElement("canvas").getContext("2d"));
		ctx.font = getComputedStyle(input).font;
		return ctx.measureText(text).width;
	};
	const resizeInput = () => {
		const textW = measureText(input.value || " ");
		const w = Math.max(CHAT_MIN_W, Math.min(Math.ceil(textW + CHAT_H_PAD), CHAT_MAX_W));
		root.style.width = w + "px";
		input.style.height = "auto";
		input.style.height = Math.max(input.scrollHeight, 22) + "px";
	};
	input.addEventListener("input", resizeInput);
	resizeInput();
	const err = document.createElement("div");
	err.className = "dsh-whale-girl-chat-err";
	err.style.display = "none";
	root.appendChild(input);
	root.appendChild(err);
	document.body.appendChild(root);
	resizeInput();
	const rr = root.getBoundingClientRect();
	root.style.left = Math.max(c.x + 4, Math.min(x, c.x + c.w - rr.width - 4)) + "px";
	root.style.top = Math.max(c.y + 4, Math.min(y, c.y + c.h - rr.height - 4)) + "px";
	let closed = false;
	let sending = false;
	const close = () => {
		if (closed) return;
		closed = true;
		document.removeEventListener("mousedown", onDocPointerDown, true);
		document.removeEventListener("keydown", onDocKeyDown, true);
		root.remove();
		if (onClose) onClose();
	};
	const onDocPointerDown = (e) => {
		if (closed) return;
		if (root.contains(e.target)) return;
		close();
	};
	const onDocKeyDown = (e) => {
		if (closed) return;
		if (e.key === "Escape") close();
	};
	document.addEventListener("mousedown", onDocPointerDown, true);
	document.addEventListener("keydown", onDocKeyDown, true);
	const doSend = () => {
		if (closed || sending) return;
		const text = input.value.trim();
		if (!text) return;
		sending = true;
		input.disabled = true;
		sendChat(withPet, text).then((state) => {
			if (state.ok) {
				close();
				if (onSent) onSent();
			} else {
				err.textContent = "对话失败：" + humanizeModelError(state.reason, state.message);
				err.style.display = "block";
			}
		}).catch((e) => {
			err.textContent = "对话异常：" + String(e && e.message ? e.message : e);
			err.style.display = "block";
		}).finally(() => {
			sending = false;
			input.disabled = false;
			if (!closed) input.focus();
		});
	};
	input.addEventListener("keydown", (e) => {
		if (e.key === "Enter") {
			e.preventDefault();
			doSend();
		}
	});
	input.focus();
	return {
		el: root,
		close
	};
}

//#endregion
//#region src/shared/fonts.ts
const FONT_PRESETS = [
	{
		id: "candy",
		stack: "\"ShangshouSoftCandy\",\"Yuanti SC\",\"YouYuan\",\"幼圆\",\"Comic Sans MS\",\"PingFang SC\",\"Microsoft YaHei\",sans-serif"
	},
	{
		id: "yahei",
		stack: "\"Microsoft YaHei\",\"PingFang SC\",sans-serif"
	},
	{
		id: "youyuan",
		stack: "\"YouYuan\",\"Yuanti SC\",sans-serif"
	},
	{
		id: "kaiti",
		stack: "\"KaiTi\",\"STKaiti\",serif"
	},
	{
		id: "simsun",
		stack: "\"SimSun\",\"Songti SC\",serif"
	},
	{
		id: "comic",
		stack: "\"Comic Sans MS\",\"Comic Sans\",cursive"
	},
	{
		id: "system",
		stack: "system-ui,sans-serif"
	}
];
const FONT_SIZE_MIN = 4;
const FONT_SIZE_MAX = 200;
const DEFAULT_FONT = {
	family: "candy",
	size: 21,
	followPet: true
};
function fontStackOf(id) {
	return (FONT_PRESETS.find((p) => p.id === id) ?? FONT_PRESETS[0]).stack;
}
const FONT_REF_SIZE = 462;
const BUBBLE_FONT_BASE_PX = .0455 * FONT_REF_SIZE;
const TIP_FONT_BASE_PX = .026 * FONT_REF_SIZE;
function resolveFontPx(font, size) {
	const own = Number(font?.size);
	const ratio = Number.isFinite(own) && own > 0 ? own / DEFAULT_FONT.size : 1;
	const w = Number(size);
	const follow = font?.followPet !== false;
	const scale = follow && Number.isFinite(w) && w > 0 ? w / FONT_REF_SIZE : 1;
	return {
		bubble: BUBBLE_FONT_BASE_PX * ratio * scale,
		tip: TIP_FONT_BASE_PX * ratio * scale
	};
}

//#endregion
//#region src/shared/physics.ts
const SPRING_K = 200;
const SPRING_C = 30;
const TRAIL_KEEP_MS = 200;
const RELEASE_WINDOW_MS = 150;
const RELEASE_STALE_MS = 150;
const MIN_SPAN_MS = 20;
const SEG_MIN_DT_MS = 8;
const DEAD_ZONE_SPEED = 500;
const MAX_THROW_SPEED = 3600;
const PEAK_WEIGHT = .5;
const ACCEL_REF = 8e3;
const ACCEL_GAIN_MAX = .6;
const GRAVITY = 1400;
const RESTITUTION = .78;
const GROUND_FRICTION = 2.5;
const DEFAULT_PHYSICS = {
	gravity: GRAVITY,
	restitution: RESTITUTION,
	groundFriction: GROUND_FRICTION,
	ceilingBounce: true,
	throwPower: 1,
	petCollision: false
};
const DEFAULT_THROW_POWER = 1;
const REST_VY = 40;
const REST_VX = 15;
const MAX_STEP_DT = .05;
const SQ_SQUASH = .55;
const SQ_DURATION_MS = 220;
const SQ_SOFT_SPEED = 300;
const SQ_HARD_SPEED = 1500;
const SQ_MAX_SQUASH = .55;
const landingSquash = (impactSpeed) => {
	const t = Math.min(Math.max((Math.abs(impactSpeed) - SQ_SOFT_SPEED) / (SQ_HARD_SPEED - SQ_SOFT_SPEED), 0), 1);
	return Math.min(.8, 1 - t * (1 - SQ_MAX_SQUASH));
};
const squashScale = (u, squash = SQ_SQUASH) => {
	if (u < .45) {
		const p$1 = u / .45;
		return 1 - (1 - squash) * p$1 * p$1;
	}
	const p = (u - .45) / .55;
	const c1 = 1.70158;
	const c3 = c1 + 1;
	const f = 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
	return Math.min(1.12, squash + (1 - squash) * Math.max(f, 0));
};
const throwBounds = (o) => {
	const h = o.size * 9 / 16;
	return {
		minX: -o.sideAllow,
		minY: 0,
		maxX: o.W - o.size + o.sideAllow,
		maxY: o.H - h
	};
};
const trimTrail = (trail, now) => {
	const cutoff = now - TRAIL_KEEP_MS;
	let i = 0;
	while (i < trail.length && trail[i].t < cutoff) i++;
	return i === 0 ? trail : trail.slice(i);
};
const springStep = (v, x, target, dt, power = DEFAULT_THROW_POWER) => v + ((target - x) * SPRING_K - v * SPRING_C) * power * dt;
const softClampSpeed = (speed) => {
	if (speed <= 0) return 0;
	return MAX_THROW_SPEED * (1 - Math.exp(-speed / MAX_THROW_SPEED));
};
const estimateReleaseVelocity = (trail, now, physics = DEFAULT_PHYSICS) => {
	if (trail.length === 0) return null;
	const last = trail[trail.length - 1];
	if (now - last.t > RELEASE_STALE_MS) return null;
	const win = trail.filter((s) => now - s.t <= RELEASE_WINDOW_MS);
	if (win.length < 2) return null;
	const t0 = win[0].t;
	const x0 = win[0].x;
	const y0 = win[0].y;
	const t1 = win[win.length - 1].t;
	const x1 = win[win.length - 1].x;
	const y1 = win[win.length - 1].y;
	const spanMs = t1 - t0;
	if (spanMs < MIN_SPAN_MS) return null;
	const baseVx = (x1 - x0) / spanMs * 1e3;
	const baseVy = (y1 - y0) / spanMs * 1e3;
	const baseSpeed = Math.hypot(baseVx, baseVy);
	if (baseSpeed < 1e-6) return null;
	const segSpeeds = [];
	let px = x0;
	let py = y0;
	let pt = t0;
	for (const s of win.slice(1)) {
		const dt = s.t - pt;
		if (dt >= SEG_MIN_DT_MS) {
			segSpeeds.push({
				speed: Math.hypot(s.x - px, s.y - py) / dt * 1e3,
				tEnd: s.t
			});
			px = s.x;
			py = s.y;
			pt = s.t;
		}
	}
	const peakSpeed = segSpeeds.length ? Math.max(...segSpeeds.map((v) => v.speed)) : baseSpeed;
	let accel = 0;
	if (segSpeeds.length >= 2) {
		const lastSeg = segSpeeds[segSpeeds.length - 1];
		const firstSeg = segSpeeds[0];
		accel = (lastSeg.speed - firstSeg.speed) / Math.max((lastSeg.tEnd - firstSeg.tEnd) / 1e3, MIN_SPAN_MS / 1e3);
	}
	const speedBeforeClamp = ((1 - PEAK_WEIGHT) * baseSpeed + PEAK_WEIGHT * peakSpeed) * (1 + Math.min(Math.max(accel, 0) / ACCEL_REF, 1) * ACCEL_GAIN_MAX);
	const speed = softClampSpeed(speedBeforeClamp) * physics.throwPower;
	if (speed < DEAD_ZONE_SPEED) return null;
	return {
		vx: baseVx / baseSpeed * speed,
		vy: baseVy / baseSpeed * speed
	};
};
const throwStep = (s, dtRaw, b, physics = DEFAULT_PHYSICS) => {
	const dt = Math.min(Math.max(dtRaw, 0), MAX_STEP_DT);
	let { x, y, vx, vy } = s;
	vy += physics.gravity * dt;
	x += vx * dt;
	y += vy * dt;
	let bounced = false;
	if (x < b.minX) {
		x = b.minX;
		vx = Math.abs(vx) * physics.restitution;
		bounced = true;
	} else if (x > b.maxX) {
		x = b.maxX;
		vx = -Math.abs(vx) * physics.restitution;
		bounced = true;
	}
	if (y < b.minY) {
		if (physics.ceilingBounce) {
			y = b.minY;
			vy = Math.abs(vy) * physics.restitution;
			bounced = true;
		}
	} else if (y >= b.maxY) {
		y = b.maxY;
		vx *= Math.max(0, 1 - physics.groundFriction * dt);
		if (Math.abs(vy) < REST_VY) vy = 0;
		else vy = -Math.abs(vy) * physics.restitution;
		bounced = true;
	}
	const speed = Math.hypot(vx, vy);
	const atRest = y >= b.maxY - 1 && Math.abs(vy) < 1 && Math.abs(vx) < REST_VX || bounced && speed < REST_VY && Math.abs(vy) < 1;
	return {
		x,
		y,
		vx,
		vy,
		bounced,
		atRest
	};
};
const PET_BOUNCE_E = .995;
const bodyPixelBox = (o) => {
	const h = o.size * 9 / 16;
	return {
		left: o.x + HIT_BOX.x0 / 640 * o.size,
		top: o.y + o.bottomPad + HIT_BOX.y0 / 360 * h,
		right: o.x + HIT_BOX.x1 / 640 * o.size,
		bottom: o.y + o.bottomPad + HIT_BOX.y1 / 360 * h
	};
};
const rectsOverlap = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
const collidePet = (fly, hit) => {
	const hf = fly.size * 9 / 16 / 2;
	const hh = hit.size * 9 / 16 / 2;
	const cx = hit.x + hit.size / 2 - (fly.x + fly.size / 2);
	const cy = hit.y + hh - (fly.y + hf);
	const dist = Math.hypot(cx, cy);
	if (dist < 1e-6) return null;
	const nx = cx / dist;
	const ny = cy / dist;
	const vrel = (fly.vx - hit.vx) * nx + (fly.vy - hit.vy) * ny;
	if (vrel <= 0) return null;
	const e = PET_BOUNCE_E;
	const m1 = fly.size * fly.size;
	const m2 = hit.size * hit.size;
	const v1n = fly.vx * nx + fly.vy * ny;
	const v2n = hit.vx * nx + hit.vy * ny;
	const v1n2 = ((m1 - e * m2) * v1n + (1 + e) * m2 * v2n) / (m1 + m2);
	const v2n2 = ((m2 - e * m1) * v2n + (1 + e) * m1 * v1n) / (m1 + m2);
	return {
		fvx: fly.vx - v1n * nx + v1n2 * nx,
		fvy: fly.vy - v1n * ny + v1n2 * ny,
		hvx: hit.vx - v2n * nx + v2n2 * nx,
		hvy: hit.vy - v2n * ny + v2n2 * ny
	};
};

//#endregion
//#region src/shared/notify.ts
const NOTIFY_ICONS$1 = {
	done: "notify-done",
	error: "notify-error",
	truncated: "notify-truncated",
	approval: "notify-approval",
	question: "notify-question",
	test: "notify-test"
};
const MAX_BODY = 80;
function truncate(text) {
	return text.length > MAX_BODY ? text.slice(0, MAX_BODY) + "…" : text;
}
function frameToToast(frame) {
	switch (frame.type) {
		case "session/event": {
			const ev = frame.event ?? {};
			if (ev.type !== "turn/end") return null;
			const kind = ev.data?.reason?.kind;
			if (kind === "completed") return {
				title: "对话完成",
				body: "",
				icon: NOTIFY_ICONS$1.done
			};
			if (kind === "error") return {
				title: "生成失败",
				body: ev.data?.reason?.error?.message ?? "",
				icon: NOTIFY_ICONS$1.error
			};
			if (kind === "max-tokens") return {
				title: "输出被截断",
				body: "已达到输出 token 上限",
				icon: NOTIFY_ICONS$1.truncated
			};
			return null;
		}
		case "approval/requested": {
			const toolName = typeof frame.toolName === "string" ? frame.toolName : "";
			const reason = typeof frame.reason === "string" && frame.reason ? frame.reason : "";
			return {
				title: "正在申请权限",
				body: (toolName ? "工具「" + toolName + "」" : "") + (reason ? "：" + reason : ""),
				icon: NOTIFY_ICONS$1.approval
			};
		}
		case "question/requested": {
			const q = Array.isArray(frame.questions) && frame.questions[0]?.question || "";
			return {
				title: "模型在等你回答",
				body: q,
				icon: NOTIFY_ICONS$1.question
			};
		}
		case "host/agent-error": return {
			title: "生成失败",
			body: typeof frame.message === "string" ? frame.message : "",
			icon: NOTIFY_ICONS$1.error
		};
		default: return null;
	}
}

//#endregion
//#region src/client/notify.ts
let pageVisible = typeof document !== "undefined" && !document.hidden;
let pageFocused = typeof document !== "undefined" && document.hasFocus();
function refreshVisible() {
	pageVisible = !document.hidden;
}
function refreshFocused() {
	pageFocused = document.hasFocus();
}
/** 注册聚焦/可见性监听，返回解绑函数 */
function initFocusTracking() {
	if (typeof document === "undefined") return () => {};
	document.addEventListener("visibilitychange", refreshVisible);
	window.addEventListener("focus", refreshFocused);
	window.addEventListener("blur", refreshFocused);
	return () => {
		document.removeEventListener("visibilitychange", refreshVisible);
		window.removeEventListener("focus", refreshFocused);
		window.removeEventListener("blur", refreshFocused);
	};
}
/** 用户是否在看本页（页面可见且持有焦点）——是则跳过通知 */
function isPageActive() {
	return pageVisible && pageFocused;
}
/** 图标 URL（pic 路由由宿主提供：assets/pic → /dsh-whale-girl/pic/<file>） */
const PIC = (name) => "/dsh-whale-girl/pic/" + name + ".png";
const NOTIFY_ICONS = {
	done: PIC(NOTIFY_ICONS$1.done),
	error: PIC(NOTIFY_ICONS$1.error),
	truncated: PIC(NOTIFY_ICONS$1.truncated),
	approval: PIC(NOTIFY_ICONS$1.approval),
	question: PIC(NOTIFY_ICONS$1.question),
	test: PIC(NOTIFY_ICONS$1.test)
};
/** 当前生效的总开关（运行中可被 reloadNotifications 更新——设置页保存后即时生效，无需刷新） */
let notifyEnabled = true;
/** 发一条系统通知；总开关关闭 / 环境不支持 / 未授权 / 聚焦本页 时静默跳过。
* 日志（【弹窗】类型：内容）在门之后记录——只有真正发出通知时才记，被门拦下的触发不产生日志。 */
function toast(title, body, icon) {
	if (!notifyEnabled) return;
	if (isPageActive()) return;
	if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
	console.log("【弹窗】" + title + (body ? "：" + body : ""));
	try {
		const opts = {};
		if (body) opts.body = truncate(body);
		if (icon) opts.icon = icon;
		const n = new Notification(title, opts);
		n.onclick = () => {
			window.focus();
			n.close();
		};
	} catch {}
}
/** 帧 → toast 并发出（映射来自 shared；未知帧静默跳过） */
function toastFrame(frame) {
	const t = frameToToast(frame);
	if (!t) return;
	toast(t.title, t.body, PIC(t.icon));
}
async function requestNotificationPermission() {
	if (typeof Notification === "undefined") return {
		ok: false,
		reason: "unsupported"
	};
	if (Notification.permission === "granted") return { ok: true };
	if (Notification.permission === "denied") return {
		ok: false,
		reason: "denied"
	};
	try {
		const p = await Notification.requestPermission();
		if (p === "granted") return { ok: true };
		if (p === "denied") return {
			ok: false,
			reason: "rejected"
		};
		return {
			ok: false,
			reason: "error",
			message: "权限未授予（" + p + "）"
		};
	} catch (e) {
		return {
			ok: false,
			reason: "error",
			message: e instanceof Error ? e.message : String(e)
		};
	}
}
/** 读取系统通知总开关：读成品聚合 main 条目（用户层优先、缺省回落默认，host 已合并好）；
* 拉取/解析失败时不阻塞（默认开启）。 */
async function readNotificationsEnabled() {
	try {
		const r = await fetch("/dsh-whale-girl/config");
		if (!r.ok) return true;
		const d = await r.json().catch(() => null);
		return typeof d?.main?.notificationsEnabled === "boolean" ? d.main.notificationsEnabled : true;
	} catch {
		return true;
	}
}
async function reloadNotifications() {
	notifyEnabled = await readNotificationsEnabled();
}
function notifyFromFrame(frame) {
	toastFrame(frame);
}
function initNotify() {
	readNotificationsEnabled().then((enabled) => {
		notifyEnabled = enabled;
		if (typeof Notification !== "undefined" && enabled && Notification.permission === "default") requestNotificationPermission();
	});
	return initFocusTracking();
}

//#endregion
//#region src/client/voice-client.ts
/** 宿主路由前缀 */
const PREFIX$2 = "/dsh-whale-girl";
/** 最短录音（秒）：太短的当作误触，不送识别 */
const MIN_SECONDS = .35;
/** 录音中宠物头顶显示的提示（走宿主现有的 broadcast 通道，不新增端点） */
const LISTENING_TEXT = "······";
/** 把 16 kHz 单声道浮点采样编码成 PCM16 WAV（44 字节头，`data` 必须正好在偏移 36） */
function encodePcm16Wav(samples) {
	const bytes = new Uint8Array(44 + samples.length * 2);
	const view = new DataView(bytes.buffer);
	const ascii = (at, text) => {
		for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i);
	};
	ascii(0, "RIFF");
	view.setUint32(4, bytes.length - 8, true);
	ascii(8, "WAVE");
	ascii(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, 16e3, true);
	view.setUint32(28, 32e3, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	ascii(36, "data");
	view.setUint32(40, samples.length * 2, true);
	for (let i = 0; i < samples.length; i++) {
		const clamped = Math.max(-1, Math.min(1, samples[i]));
		view.setInt16(44 + i * 2, Math.round(clamped * (clamped < 0 ? 32768 : 32767)), true);
	}
	return bytes;
}
/** 任意采样率的单声道采样 → 16 kHz → PCM16 WAV */
async function toCanonicalWav(samples, sampleRate) {
	if (sampleRate === 16e3) return encodePcm16Wav(samples);
	const frames = Math.max(1, Math.floor(samples.length * 16e3 / sampleRate));
	const buffer = new AudioBuffer({
		length: Math.max(1, samples.length),
		sampleRate,
		numberOfChannels: 1
	});
	buffer.copyToChannel(samples, 0);
	const offline = new OfflineAudioContext(1, frames, 16e3);
	const source = offline.createBufferSource();
	source.buffer = buffer;
	source.connect(offline.destination);
	source.start();
	const rendered = await offline.startRendering();
	return encodePcm16Wav(rendered.getChannelData(0));
}
/**
* 用 AudioContext 直接抓采样，**不用 MediaRecorder**。
*
* 为什么必须换掉 MediaRecorder：本机 Electron 里
* `new MediaRecorder(stream).mimeType` 是**空字符串**——它选不出任何可用编码格式，
* 于是录音器起来后立刻自我终止：`chunks` 永远是 0、`state` 是 `inactive`
* （voice-trace.log 里连续三条实测记录都是 `chunks:0, state:"inactive"`，`mime:""`）。
* 这是那条 API 在这个环境不可用，不是我们的逻辑错。
*
* `ScriptProcessorNode` 虽被标 deprecated，但在所有 Chromium 上都能跑、
* 不需要额外的 worker 模块文件；对「录一句几秒钟的话」完全够用。
*/
async function startCapture(stream) {
	const context = new AudioContext();
	await context.resume().catch(() => {});
	const source = context.createMediaStreamSource(stream);
	const processor = context.createScriptProcessor(4096, 1, 1);
	const blocks = [];
	let stopped = false;
	processor.onaudioprocess = (event) => {
		if (stopped) return;
		blocks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
	};
	source.connect(processor);
	processor.connect(context.destination);
	const sampleRate = context.sampleRate;
	const totalSamples = () => blocks.reduce((n, b) => n + b.length, 0);
	const release = () => {
		stopped = true;
		processor.onaudioprocess = null;
		try {
			processor.disconnect();
		} catch {}
		try {
			source.disconnect();
		} catch {}
		context.close().catch(() => {});
	};
	return {
		seconds: () => totalSamples() / sampleRate,
		blocks: () => blocks.length,
		async stop() {
			release();
			const length = totalSamples();
			const samples = new Float32Array(length);
			let offset = 0;
			for (const b of blocks) {
				samples.set(b, offset);
				offset += b.length;
			}
			return {
				samples,
				sampleRate
			};
		},
		abort: release
	};
}
/** Uint8Array → base64（分块，避免大数组爆栈） */
function toBase64(bytes) {
	let text = "";
	for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
	return btoa(text);
}
/**
* 上报一步进度到宿主日志（`$DSH_HOME/dsh-whale-girl/voice-trace.log`）。
*
* 为什么要有：语音链路在前端有六七步，任何一步静默失败都表现为「按了没反应」，
* 而浏览器控制台主人不方便看。落成文件后宿主侧一次 GET 就能看到断在哪一步。
* 纯诊断，**失败静默**——绝不能因为日志发不出去影响主流程。
*/
function trace(step, detail) {
	try {
		fetch(`${PREFIX$2}/voice/trace`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				step,
				detail
			}),
			cache: "no-store"
		}).catch(() => {});
	} catch {}
}
/** 发一个 JSON 请求，把「网络失败」与「业务失败」都折成结构化结果 */
async function postJson(path, body) {
	try {
		const response = await fetch(`${PREFIX$2}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			cache: "no-store"
		});
		if (!response.ok) return {
			ok: false,
			message: `请求失败（HTTP ${response.status}）`
		};
		return {
			ok: true,
			data: await response.json()
		};
	} catch (e) {
		return {
			ok: false,
			message: e instanceof Error ? e.message : String(e)
		};
	}
}
const DEFAULT_SHORTCUT = "Alt+V";
const VOICE_CONFIG_EVENT = "dsh-whale-girl:voice-config";
/** 取语音配置（每次开录前都取一次：设置页保存后立刻生效，不必刷新） */
async function loadVoiceConfig() {
	try {
		const res = await fetch(`${PREFIX$2}/voice/config`, { cache: "no-store" });
		if (!res.ok) return {};
		return await res.json();
	} catch {
		return {};
	}
}
/** 容器样式（固定在右下角，避开宠物本体） */
const ROOT_STYLE$1 = [
	"position:fixed",
	"right:16px",
	"bottom:96px",
	"z-index:2147483000",
	"display:flex",
	"align-items:center",
	"gap:8px",
	"pointer-events:auto",
	"user-select:none"
].join(";");
const BUTTON_STYLE = [
	"width:44px",
	"height:44px",
	"border-radius:50%",
	"border:1px solid rgba(255,255,255,.22)",
	"background:rgba(20,28,48,.82)",
	"color:#e8f0ff",
	"font-size:18px",
	"line-height:1",
	"cursor:pointer",
	"display:flex",
	"align-items:center",
	"justify-content:center",
	"transition:transform .12s ease, background .12s ease",
	"box-shadow:0 4px 16px rgba(0,0,0,.35)"
].join(";");
const LABEL_STYLE$1 = [
	"font-size:12px",
	"color:#cfe0ff",
	"background:rgba(20,28,48,.72)",
	"padding:4px 8px",
	"border-radius:8px",
	"white-space:nowrap",
	"max-width:320px",
	"overflow:hidden",
	"text-overflow:ellipsis"
].join(";");
const STATE_TEXT = {
	idle: "按住说话",
	recording: "松开结束",
	recognizing: "识别中…",
	thinking: "思考中…",
	speaking: "说话中（再按可打断）",
	error: ""
};
/** 把 CSS 字符串转成 React 的 style 对象（React 的 style 不接受字符串） */
function parseStyle$1(css$1) {
	const out = {};
	for (const part of css$1.split(";")) {
		const index = part.indexOf(":");
		if (index <= 0) continue;
		const key = part.slice(0, index).trim();
		const value = part.slice(index + 1).trim();
		if (key === "" || value === "") continue;
		out[key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
	}
	return out;
}
const styles$1 = {
	root: parseStyle$1(ROOT_STYLE$1),
	label: parseStyle$1(LABEL_STYLE$1),
	heard: parseStyle$1([
		"font-size:12px",
		"color:#e8f0ff",
		"background:rgba(96,140,255,.35)",
		"border:1px solid rgba(96,140,255,.5)",
		"padding:4px 8px",
		"border-radius:8px",
		"white-space:nowrap",
		"max-width:320px",
		"overflow:hidden",
		"text-overflow:ellipsis"
	].join(";")),
	button: parseStyle$1(BUTTON_STYLE),
	buttonActive: parseStyle$1(`${BUTTON_STYLE};background:rgba(96,140,255,.92)`),
	buttonBusy: parseStyle$1(`${BUTTON_STYLE};opacity:.6;cursor:progress`)
};
/** 解析快捷键字符串（`Alt+V` / `Ctrl+Shift+Space` / `F8`） */
function parseShortcut(text) {
	const parts = text.split("+").map((p) => p.trim().toLowerCase()).filter((p) => p !== "");
	if (parts.length === 0) return void 0;
	const key = parts[parts.length - 1];
	if (key === "") return void 0;
	const mods = new Set(parts.slice(0, -1));
	const known = new Set([
		"alt",
		"ctrl",
		"control",
		"shift",
		"meta",
		"cmd",
		"win"
	]);
	if ([...mods].some((m) => !known.has(m))) return void 0;
	return {
		mods,
		key
	};
}
/** 判断一次按键事件是否命中该快捷键（修饰键精确匹配） */
function matches(event, combo) {
	const wantAlt = combo.mods.has("alt");
	const wantCtrl = combo.mods.has("ctrl") || combo.mods.has("control");
	const wantShift = combo.mods.has("shift");
	const wantMeta = combo.mods.has("meta") || combo.mods.has("cmd") || combo.mods.has("win");
	if (event.altKey !== wantAlt) return false;
	if (event.ctrlKey !== wantCtrl) return false;
	if (event.shiftKey !== wantShift) return false;
	if (event.metaKey !== wantMeta) return false;
	const pressed = event.key.toLowerCase();
	const normalized = pressed === " " ? "space" : pressed;
	return normalized === combo.key || event.code.toLowerCase() === combo.key;
}
function makeVoiceButton(rt) {
	const { h, useState, useRef, useCallback, useEffect } = rt;
	return function VoiceButton(props) {
		const [state, setState] = useState("idle");
		const [message, setMessage] = useState("");
		const [heard, setHeard] = useState("");
		const [shortcut, setShortcut] = useState(DEFAULT_SHORTCUT);
		const [hidden, setHidden] = useState(false);
		const captureRef = useRef(void 0);
		const streamRef = useRef(void 0);
		const startedWallRef = useRef(0);
		const audioRef = useRef(void 0);
		const urlRef = useRef(void 0);
		const busyRef = useRef(false);
		/**
		* 「还没开始录就松手了」的标记。
		*
		* `startRecording` 要先 await getUserMedia（几十到几百毫秒），这期间
		* recorderRef 还是空的。若主人按得快、松得早，`finish()` 会看到
		* recorderRef === undefined 直接返回——表现就是**按了、气泡出来了、然后什么都不发生**。
		* 用这个标记把「松手」记住，等录音器真的起来后立刻收尾。
		*/
		const stopRequestedRef = useRef(false);
		/**
		* 防重入：`startRecording` 里有 await（读配置 + getUserMedia），
		* 这段窗口内任何再次触发（按键重复、连点）都会开出第二个录音器并覆盖 ref，
		* 结果两个都残废。加这把锁，第二次触发只记「等会儿停」。
		*/
		const startingRef = useRef(false);
		const cleanupStream = useCallback(() => {
			captureRef.current?.abort();
			captureRef.current = void 0;
			streamRef.current?.getTracks().forEach((track) => track.stop());
			streamRef.current = void 0;
		}, []);
		const stopPlayback = useCallback(() => {
			const audio = audioRef.current;
			if (audio !== void 0) {
				audio.pause();
				audio.currentTime = 0;
				audioRef.current = void 0;
			}
			if (urlRef.current !== void 0) {
				URL.revokeObjectURL(urlRef.current);
				urlRef.current = void 0;
			}
		}, []);
		/** 录音开始：让宠物头顶冒一个「······」，告诉人「我在听」 */
		const showListening = useCallback(() => {
			postJson("/broadcast", { text: LISTENING_TEXT }).catch(() => {});
		}, []);
		/** 松手后：编码 → turn → tts → 播放 */
		const finish = useCallback(async () => {
			const capture = captureRef.current;
			if (capture === void 0) {
				if (stateRef.current === "recording") stopRequestedRef.current = true;
				return;
			}
			captureRef.current = void 0;
			const seconds = capture.seconds();
			const blockCount = capture.blocks();
			let recorded;
			try {
				recorded = await capture.stop();
			} catch (e) {
				cleanupStream();
				setState("error");
				setMessage("录音收尾失败：" + humanizeModelError(void 0, e instanceof Error ? e.message : String(e)));
				return;
			}
			cleanupStream();
			trace("stop", {
				seconds: Number(seconds.toFixed(2)),
				blocks: blockCount,
				samples: recorded.samples.length,
				rate: recorded.sampleRate
			});
			if (seconds < MIN_SECONDS) {
				setState("error");
				setMessage(`太短了（${seconds.toFixed(1)}s），按住多说一会儿`);
				return;
			}
			if (recorded.samples.length === 0 || blockCount === 0) {
				setState("error");
				setMessage("没收到音频采样（麦克风没有输出数据）");
				return;
			}
			setState("recognizing");
			busyRef.current = true;
			try {
				const wav = await toCanonicalWav(recorded.samples, recorded.sampleRate);
				trace("wav", { bytes: wav.length });
				setState("thinking");
				const turn = await postJson("/voice/turn", { audio: toBase64(wav) });
				trace("turn", {
					transportOk: turn.ok,
					reason: turn.ok ? turn.data.reason : turn.message,
					userText: turn.ok ? turn.data.userText : void 0,
					replyLength: turn.ok ? (turn.data.reply ?? "").length : void 0
				});
				const recognized = (turn.ok ? turn.data.userText : void 0)?.trim();
				if (recognized !== void 0 && recognized !== "") setHeard(recognized);
				if (!turn.ok) {
					setState("error");
					setMessage(humanizeModelError(void 0, turn.message));
					return;
				}
				if (!turn.data.ok) {
					setState("error");
					setMessage(humanizeModelError(turn.data.reason, turn.data.message));
					return;
				}
				const reply = (turn.data.reply ?? "").trim();
				if (reply === "") {
					setState("idle");
					return;
				}
				setState("speaking");
				trace("tts:request", { chars: reply.length });
				const response = await fetch(`${PREFIX$2}/voice/tts`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ text: reply }),
					cache: "no-store"
				});
				if (!response.ok) {
					setState("error");
					setMessage(`语音合成失败（HTTP ${response.status}）`);
					return;
				}
				const bytes = await response.arrayBuffer();
				const mime = response.headers.get("content-type") ?? "audio/mpeg";
				trace("tts:response", {
					bytes: bytes.byteLength,
					mime
				});
				if (bytes.byteLength === 0) {
					setState("error");
					setMessage("语音合成失败");
					return;
				}
				const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
				urlRef.current = url;
				const player = new Audio(url);
				audioRef.current = player;
				player.addEventListener("ended", () => {
					stopPlayback();
					setState("idle");
				});
				player.addEventListener("error", () => {
					stopPlayback();
					setState("error");
					setMessage("音频播放失败");
				});
				try {
					await player.play();
					trace("play:start");
				} catch (e) {
					setState("error");
					setMessage("音频被系统拦下（点一下页面再试）：" + humanizeModelError(void 0, e instanceof Error ? e.message : String(e)));
					return;
				}
			} catch (e) {
				trace("error", { message: e instanceof Error ? e.message : String(e) });
				setState("error");
				setMessage(humanizeModelError(void 0, e instanceof Error ? e.message : String(e)));
			} finally {
				busyRef.current = false;
			}
		}, [cleanupStream, stopPlayback]);
		const startRecording = useCallback(async () => {
			if (startingRef.current) {
				stopRequestedRef.current = true;
				return;
			}
			startingRef.current = true;
			setMessage("");
			setHeard("");
			stopRequestedRef.current = false;
			setState("recording");
			stateRef.current = "recording";
			try {
				const devices = navigator.mediaDevices;
				if (devices === void 0) throw new Error("这个环境不支持麦克风");
				const cfg = await loadVoiceConfig();
				const micId = cfg.micDeviceId ?? "";
				const constraints = {
					audio: {
						echoCancellation: true,
						noiseSuppression: true,
						...micId === "" ? {} : { deviceId: { exact: micId } }
					},
					video: false
				};
				const stream = await devices.getUserMedia(constraints);
				streamRef.current = stream;
				const capture = await startCapture(stream);
				captureRef.current = capture;
				startedWallRef.current = performance.now();
				trace("record:start", {
					mic: micId === "" ? "default" : micId.slice(0, 8),
					tracks: stream.getAudioTracks().length
				});
				showListening();
				if (stopRequestedRef.current) {
					stopRequestedRef.current = false;
					trace("record:early-stop");
					finish();
				}
			} catch (e) {
				cleanupStream();
				setState("error");
				const name = e instanceof DOMException ? e.name : "";
				setMessage(name === "NotAllowedError" ? "麦克风权限被拒绝（请在系统设置里允许）" : name === "NotFoundError" ? "没找到麦克风" : name === "OverconstrainedError" ? "选定的麦克风不可用（设置里换一个）" : e instanceof Error ? e.message : String(e));
				trace("record:error", {
					name,
					message: e instanceof Error ? e.message : String(e)
				});
			} finally {
				startingRef.current = false;
			}
		}, [
			cleanupStream,
			showListening,
			finish
		]);
		useEffect(() => {
			let alive = true;
			const reload = () => {
				(async () => {
					const cfg = await loadVoiceConfig();
					if (!alive) return;
					if (typeof cfg.shortcut === "string" && cfg.shortcut.trim() !== "") setShortcut(cfg.shortcut.trim());
					setHidden(cfg.hideButton === "true");
				})();
			};
			reload();
			window.addEventListener(VOICE_CONFIG_EVENT, reload);
			window.addEventListener("focus", reload);
			return () => {
				alive = false;
				window.removeEventListener(VOICE_CONFIG_EVENT, reload);
				window.removeEventListener("focus", reload);
			};
		}, []);
		const stateRef = useRef(state);
		stateRef.current = state;
		/**
		* 「按下」的完整语义 —— 按钮、页面快捷键、宿主全局热键三条入口共用同一份。
		*
		* 说话/识别/思考中按下 = 打断并**立刻开始新一轮**（只停不录会让主人以为快捷键坏了）。
		*/
		const pressDown = useCallback(() => {
			const now = stateRef.current;
			if (now === "speaking" || now === "recognizing" || now === "thinking") {
				stopPlayback();
				setState("idle");
				stateRef.current = "idle";
				startRecording();
				return;
			}
			if (now === "idle" || now === "error") startRecording();
		}, [startRecording, stopPlayback]);
		/** 「松开」的完整语义：只有正在录音才收尾（重复的 up 是空操作） */
		const pressUp = useCallback(() => {
			if (stateRef.current === "recording") finish();
		}, [finish]);
		useEffect(() => {
			const combo = parseShortcut(shortcut);
			if (combo === void 0) return;
			/**
			* 是否该忽略这次按键。
			*
			* 只在「输入框里且没有修饰键」时忽略：用 Alt+V 时焦点通常就在聊天输入框里，
			* 若也按 isTyping 拦掉，快捷键就永远不会触发（这正是「按 Alt+V 没反应」的原因）。
			* 带修饰键的组合本来不产生普通字符，不必让位给输入。
			*/
			const shouldIgnore = (event) => {
				if (event.altKey || event.ctrlKey || event.metaKey) return false;
				const el = event.target;
				if (!el || typeof el.tagName !== "string") return false;
				const tag = el.tagName.toLowerCase();
				return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable === true;
			};
			const down = (event) => {
				if (event.repeat) return;
				if (!matches(event, combo) || shouldIgnore(event)) return;
				event.preventDefault();
				trace("key:down", {
					key: event.key,
					code: event.code,
					target: event.target?.tagName
				});
				pressDown();
			};
			const up = (event) => {
				if (!matches(event, combo)) return;
				event.preventDefault();
				trace("key:up", {
					key: event.key,
					state: stateRef.current
				});
				pressUp();
			};
			window.addEventListener("keydown", down, true);
			window.addEventListener("keyup", up, true);
			return () => {
				window.removeEventListener("keydown", down, true);
				window.removeEventListener("keyup", up, true);
			};
		}, [
			shortcut,
			pressDown,
			pressUp
		]);
		/**
		* 宿主级全局热键（SSE）：DSH 窗口失焦 / 最小化 / 被别的应用挡住时也能用。
		*
		* 页面里的 `keydown` 只在本页有焦点时触发；宿主侧的轮询进程不依赖焦点
		* （见 src/host/hotkey.ts），把 DOWN/UP 通过 `text/event-stream` 推过来。
		* 页面在后台时 EventSource 仍然收得到——这正是这条链路存在的意义。
		*
		* 两条路径同时触发不会出问题：`startRecording` 有防重入、`finish` 有状态判定，
		* 焦点在页面里时浏览器那条会先到，宿主这条再到达时状态已经不是 idle/recording。
		*/
		useEffect(() => {
			if (typeof EventSource === "undefined") return void 0;
			let source;
			try {
				source = new EventSource(`${PREFIX$2}/voice/hotkey/stream`);
			} catch {
				return void 0;
			}
			const onHotkey = (event) => {
				try {
					const data = JSON.parse(event.data);
					if (data.type === "down") {
						trace("hotkey:down", { state: stateRef.current });
						pressDown();
					} else if (data.type === "up") {
						trace("hotkey:up", { state: stateRef.current });
						pressUp();
					}
				} catch {}
			};
			source.addEventListener("hotkey", onHotkey);
			return () => {
				source.removeEventListener("hotkey", onHotkey);
				source.close();
			};
		}, [pressDown, pressUp]);
		useEffect(() => {
			if (state !== "idle") return void 0;
			const timer = setTimeout(() => {
				setHeard("");
				setMessage("");
			}, 6e3);
			return () => clearTimeout(timer);
		}, [state]);
		if (hidden && state === "idle") return null;
		const active = state === "recording" || state === "speaking";
		const busy = state === "recognizing" || state === "thinking";
		const label = state === "idle" ? message : state === "error" ? message || "出错了" : STATE_TEXT[state] || message;
		const heardLine = heard === "" ? "" : `听到：${heard}`;
		return h("div", {
			style: styles$1.root,
			children: [
				label === "" ? null : h("span", {
					key: "label",
					style: styles$1.label,
					children: label
				}),
				heardLine === "" ? null : h("span", {
					key: "heard",
					style: styles$1.heard,
					title: heard,
					children: heardLine
				}),
				h("button", {
					key: "btn",
					type: "button",
					style: busy ? styles$1.buttonBusy : active ? styles$1.buttonActive : styles$1.button,
					title: `按住说话，松开结束（快捷键 ${shortcut}；播放中按下可打断）`,
					disabled: busy,
					onPointerDown: (event) => {
						event.preventDefault();
						if (state === "speaking" || busyRef.current) {
							stopPlayback();
							setState("idle");
							return;
						}
						if (state === "idle" || state === "error") startRecording();
					},
					onPointerUp: (event) => {
						event.preventDefault();
						finish();
					},
					onPointerLeave: (event) => {
						if (state === "recording") {
							event.preventDefault();
							finish();
						}
					},
					children: state === "recording" ? "■" : "🎤"
				})
			]
		});
	};
}

//#endregion
//#region src/client/settings.ts
const petBridge = {
	current: [],
	reload: () => {},
	template: void 0
};
const NS = "whale-girl.config";
/** 一处「服务商 + 模型」是否合法：**要么都留空（= 跟随当前对话）要么都非空**。

*  与宿主 config.ts 的 modelSelectionValid 同一套规则（非法宿主回 400，这里先就地给红字提示）。 */
const modelPairValid = (m) => m.provider.trim() === "" === (m.model.trim() === "");
/**

* 设置页内联 CSS（只服务「AI 模型」单下拉选择器）。

*

* 为什么要有 CSS 而不是全用行内 style：hover / focus-visible / 箭头旋转这些**伪类与过渡**

* 行内样式表达不了，而这个选择器是照 DSH 对话框右下角的模型选择器做的——触发器要有 hover、

* 浮层要有阴影与滚动，只能落到样式表。注入方式与宠物页面同一套（data-plugin-css 去重，

* 官方插件标准做法）。

*

* 类名统一 dsh-whale-girl-mp__ 前缀（mp = model picker），不会撞到 DSH 自己的类名。

*/
const SETTINGS_CSS = [
	".dsh-whale-girl-mp{position:relative;min-width:0;display:flex;flex-direction:column;gap:4px}",
	".dsh-whale-girl-mp__trigger{display:flex;align-items:center;gap:6px;width:100%;max-width:340px;height:28px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;text-align:left;cursor:pointer;outline:none}",
	".dsh-whale-girl-mp__trigger:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary)}",
	".dsh-whale-girl-mp__trigger:focus-visible{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}",
	".dsh-whale-girl-mp__trigger:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}",
	".dsh-whale-girl-mp__label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}",
	".dsh-whale-girl-mp__sub{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex-shrink:1000;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary))}",
	".dsh-whale-girl-mp__chevron{flex:none;margin-left:auto;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary));transition:transform .12s}",
	".dsh-whale-girl-mp__chevron.is-open{transform:rotate(180deg)}",
	".dsh-whale-girl-mp__panel{position:fixed;z-index:2147483000;display:flex;flex-direction:column;gap:4px;padding:4px;overflow:hidden;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md,10px);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-prominent,0 8px 30px rgba(0,0,0,.35));color:var(--dsw-alias-label-primary)}",
	".dsh-whale-girl-mp__search{box-sizing:border-box;width:100%;height:28px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;outline:none}",
	".dsh-whale-girl-mp__search:focus{border-color:var(--dsw-alias-state-business-primary)}",
	".dsh-whale-girl-mp__list{display:flex;flex-direction:column;min-height:0;overflow-y:auto;scrollbar-width:thin}",
	".dsh-whale-girl-mp__group{padding:6px 8px 2px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}",
	".dsh-whale-girl-mp__item{display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;border:none;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer}",
	".dsh-whale-girl-mp__item:hover:not(:disabled),.dsh-whale-girl-mp__item.is-active{background:var(--dsw-alias-interactive-bg-hover)}",
	".dsh-whale-girl-mp__item[aria-checked=\"true\"]{color:var(--dsw-alias-state-business-primary)}",
	".dsh-whale-girl-mp__item:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}",
	".dsh-whale-girl-mp__name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}",
	".dsh-whale-girl-mp__check{flex:none;margin-left:auto}",
	".dsh-whale-girl-mp__status{padding:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
	".dsh-whale-girl-cfg{container-type:inline-size;display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}",
	".dsh-whale-girl-cfg__title{display:flex;align-items:center;gap:6px;margin:0;font-size:16px;font-weight:500;line-height:24px}",
	".dsh-whale-girl-cfg__card{display:flex;flex-direction:column;gap:10px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px}",
	".dsh-whale-girl-cfg__cardHead{display:flex;align-items:center;gap:6px;min-height:20px}",
	".dsh-whale-girl-cfg__cardTitle{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}",
	".dsh-whale-girl-cfg__grid3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px 16px;align-items:end}",
	".dsh-whale-girl-cfg__grid4{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px 16px;align-items:end}",
	".dsh-whale-girl-cfg__grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 16px;align-items:end}",
	"@container (max-width:600px){.dsh-whale-girl-cfg__grid4{grid-template-columns:repeat(2,minmax(0,1fr))}}",
	"@container (max-width:400px){.dsh-whale-girl-cfg__grid2,.dsh-whale-girl-cfg__grid3,.dsh-whale-girl-cfg__grid4{grid-template-columns:minmax(0,1fr)}}",
	".dsh-whale-girl-cfg__field{display:flex;flex-direction:column;gap:4px;min-width:0}",
	".dsh-whale-girl-cfg__flabel{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--dsw-alias-label-secondary)}",
	".dsh-whale-girl-cfg__inp{box-sizing:border-box;width:100%;min-height:28px;padding:4px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none}",
	".dsh-whale-girl-cfg__inp:focus{border-color:var(--dsw-alias-state-business-primary)}",
	".dsh-whale-girl-cfg__inp:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}",
	".dsh-whale-girl-cfg__toggle{display:flex;align-items:center;gap:6px;min-width:0;font-size:13px;color:var(--dsw-alias-label-primary)}",
	".dsh-whale-girl-cfg__toggle>label{display:inline-flex;align-items:center;gap:6px;cursor:pointer;min-width:0}",
	".dsh-whale-girl-cfg__toggle>label>span{overflow-wrap:anywhere}",
	".dsh-whale-girl-cfg__toggle input[type=checkbox]{flex:none;width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-state-business-primary);cursor:pointer}",
	".dsh-whale-girl-cfg__q{position:relative;display:inline-flex;align-items:center;justify-content:center;flex:none;width:14px;height:14px;border:1px solid var(--dsw-alias-label-tertiary);border-radius:50%;color:var(--dsw-alias-label-tertiary);font-size:10px;font-style:normal;line-height:1;cursor:help;user-select:none}",
	".dsh-whale-girl-cfg__q::after{display:none;content:attr(data-tip);position:absolute;left:-4px;bottom:calc(100% + 8px);width:max-content;max-width:260px;padding:6px 10px;border-radius:8px;background:var(--dsw-alias-tooltip-bg);color:#fff;font-size:12px;font-style:normal;font-weight:400;line-height:18px;text-align:left;white-space:normal;opacity:0;visibility:hidden;pointer-events:none;transition:opacity .12s ease;box-shadow:0 6px 20px rgba(0,0,0,.22);z-index:2147483000}",
	".dsh-whale-girl-cfg__q:hover::after{display:block;opacity:1;visibility:visible}",
	".dsh-whale-girl-cfg__q.is-end::after{left:auto;right:-4px}",
	".dsh-whale-girl-cfg__btn{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:8px;padding:4px 14px;font:inherit;font-size:12px;line-height:20px;cursor:pointer;white-space:nowrap}",
	".dsh-whale-girl-cfg__btn:hover:not(:disabled):not(.is-primary){background:var(--dsw-alias-interactive-bg-hover)}",
	".dsh-whale-girl-cfg__btn:disabled{opacity:.5;cursor:default}",
	".dsh-whale-girl-cfg__btn.is-primary{border-color:var(--dsw-alias-button-info-fill);background:var(--dsw-alias-button-info-fill);color:#fff}",
	".dsh-whale-girl-cfg__btn.is-primary:hover:not(:disabled){border-color:var(--dsw-alias-button-info-hover);background:var(--dsw-alias-button-info-hover)}",
	".dsh-whale-girl-cfg__btn.is-danger{border-color:var(--dsw-alias-state-error-secondary);color:var(--dsw-alias-state-error-primary)}",
	".dsh-whale-girl-cfg__btn.is-sm{padding:2px 10px}",
	".dsh-whale-girl-cfg__btn.is-ghost{border-style:dashed;color:var(--dsw-alias-label-secondary)}",
	".dsh-whale-girl-cfg__tabs{display:flex;gap:8px;flex-wrap:wrap;align-items:center}",
	".dsh-whale-girl-cfg__tabsLabel{font-size:12px;color:var(--dsw-alias-label-secondary)}",
	".dsh-whale-girl-cfg__tab{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:8px;padding:4px 12px;font:inherit;font-size:13px;cursor:pointer}",
	".dsh-whale-girl-cfg__tab:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
	".dsh-whale-girl-cfg__tab:disabled{opacity:.5;cursor:default}",
	".dsh-whale-girl-cfg__tab.is-active{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-active)}",
	".dsh-whale-girl-cfg__tab.is-ghost{border-style:dashed;color:var(--dsw-alias-label-secondary)}",
	".dsh-whale-girl-cfg__saveBar{position:sticky;top:0;z-index:20;display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:10px 0;margin:8px 0;background:linear-gradient(180deg,var(--dsw-alias-bg-l1,rgba(20,26,48,.96)) 70%,transparent);backdrop-filter:blur(6px)}",
	".dsh-whale-girl-cfg__pageTabs{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin:14px 0 6px;padding-bottom:10px;border-bottom:1px solid var(--dsw-alias-border-l2)}",
	".dsh-whale-girl-cfg__pageTab{border:none;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:8px;padding:6px 14px;font:inherit;font-size:13px;cursor:pointer;transition:background .12s,color .12s}",
	".dsh-whale-girl-cfg__pageTab:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
	".dsh-whale-girl-cfg__pageTab.is-active{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary);font-weight:600}",
	".dsh-whale-girl-cfg__pageTab:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}",
	".dsh-whale-girl-cfg__actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:4px}",
	".dsh-whale-girl-cfg__msg{margin-left:4px;font-size:12px;color:var(--dsw-alias-state-success-primary)}",
	".dsh-whale-girl-cfg__msg.is-err{color:var(--dsw-alias-state-error-primary)}",
	".dsh-whale-girl-cfg__note{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
	".dsh-whale-girl-cfg__path{font-size:12px;line-height:18px;word-break:break-all;user-select:text;color:var(--dsw-alias-label-secondary)}",
	".dsh-whale-girl-cfg__path b{color:var(--dsw-alias-label-primary);font-weight:400}",
	".dsh-whale-girl-cfg__cmd{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,\"Courier New\",monospace;font-size:12px;line-height:18px;word-break:break-all;user-select:text;padding:6px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}"
].join("\n");
const settingsCssTag = "dsh-whale-girl/settings.css";
/** 注入设置页 CSS（只注入一次；与宠物页面 injectCss 同一套 data-plugin-css 去重） */
function injectSettingsCss() {
	if (typeof document === "undefined") return;
	if (document.querySelector("style[data-plugin-css=\"" + settingsCssTag + "\"]") !== null) return;
	const tag = document.createElement("style");
	tag.dataset.plugin = "dsh-whale-girl";
	tag.dataset.pluginCss = settingsCssTag;
	tag.textContent = SETTINGS_CSS;
	document.head.appendChild(tag);
}
const zh = {
	nav: "桌宠配置",
	intro: "管理多个桌宠：每个宠物可独立设置大小与位置（保存后即时生效）。",
	petCardTitle: "宠物配置",
	petCardHint: "每只宠物独立配置：名字 / 大小 / 显示位置 / 位置 / 偏移 / 四个功能开关。改完点最下面的「保存」即时生效。",
	globalTitle: "全局开关",
	globalHint: "所有宠物共用（pet pack 可在自己种类文件里单独覆盖）。这几个开关只改本地状态，随「保存」整包写入用户配置（不做即时写入）；系统通知在保存后即时重读，无需刷新页面。",
	cornerHint: "宠物贴着屏幕的哪个角（桌面端按各自显示器的工作区算）。",
	marginXHint: "距所选角落的水平距离（px），可为任意数字。",
	marginYHint: "距所选角落的垂直距离（px），可为任意数字。",
	"cmd.chat": "对话",
	"cmd.pet": "桌宠",
	"cmd.balance": "余额",
	petsLabel: "宠物列表",
	add: "添加宠物",
	remove: "删除",
	confirmRemove: "确定删除宠物「{id}」吗？",
	confirmTitle: "确认操作",
	cancel: "取消",
	ok: "知道了",
	atLeastOne: "至少保留一个宠物。",
	emptyPets: "暂无宠物，点击「添加宠物」创建。",
	sizeLabel: "大小（宽度 px）",
	sizeHint: "高度自动 = 宽度 × 9/16。",
	nameLabel: "名字",
	nameHint: "显示名：鼠标悬浮宠物时弹出，也会加进 AI 人设（你的名字是 X）。可重复，留空按宠物 id 处理。",
	balanceEnabled: "余额功能",
	balanceEnabledHint: "启用后该宠物触发余额动画并显示余额气泡。",
	whisperEnabled: "碎碎念",
	whisperEnabledHint: "启用后该宠物按周期用 AI 生成一句话并播碎碎念动画（人设与周期在配置文件顶层）。",
	workStatusEnabled: "工作状态联动",
	workStatusEnabledHint: "启用后该宠物跟随 DSH 工作状态：思考/工作中/等待确认/完成/出错时自动切对应动画并弹气泡（动画池在配置顶层，仅监听不调用模型）。",
	fixedEnabled: "宠物固定",
	fixedEnabledHint: "启用后随机动画不再让宠物自己转向或走开，只播原地待机与随机小动作；右键菜单点播、接口触发、余额/碎碎念/工作状态动画不受影响。",
	displayLabel: "显示位置",
	displayHint: "web=仅浏览器 / desktop=仅桌面 / both=两者都显示 / none=都不显示",
	"display.web": "仅浏览器",
	"display.desktop": "仅桌面",
	"display.both": "两者都显示",
	"display.none": "都不显示",
	cornerLabel: "位置",
	"corner.top-left": "左上角",
	"corner.top-right": "右上角",
	"corner.bottom-left": "左下角",
	"corner.bottom-right": "右下角",
	marginX: "水平偏移",
	marginY: "垂直偏移",
	save: "保存",
	sync: "同步",
	confirmSync: "确定同步吗？将用项目内置的默认配置（完整字段 + 注释）覆盖用户配置，当前的自定义内容会丢失。",
	corruptTitle: "用户配置已损坏，未保存",
	corruptConfirm: "强行保存",
	corruptBody: "用户配置文件解析不了（内容已损坏，不是合法 JSON/JSONC）：{path}。继续保存会按白名单重建这个文件——它里面现有的内容（animations / physics / memes 等自定义字段）会全部丢失。取消 = 不动文件（先去把配置改回合法再保存）；确认 = 强行保存（丢弃文件里现有的内容）。",
	syncHint: "「同步」会把项目内置的默认配置（含注释与全部高级字段）写入用户配置文件，覆盖当前自定义内容；之后可直接编辑该文件。注意两点：① 文件一旦生成即为显式覆盖层——插件升级后内置默认的变化不会自动生效（除非再次同步或删除该文件）；② 在本页点「保存」会按白名单重写该文件（字段值保留，但注释会被去掉）。",
	configMeta: "高级配置（文件）",
	configMetaHint: "用户配置可覆盖宠物列表 / 动画池 / 播放权重，修改后刷新或重启生效：浏览器端刷新页面，桌面端右键宠物 →「重载配置」（重载全部桌面宠物窗口）；默认配置为完整参考。",
	defaultConfig: "默认配置（只读，完整参考）",
	userConfig: "用户配置（自定义覆盖）",
	animationDir: "动画素材目录（可自定义/扩充动画）",
	memesDir: "表情包目录（可自定义/扩充配图）",
	saved: "已保存，桌宠即时生效。",
	loadError: "加载配置失败",
	loading: "正在加载配置…",
	retry: "重试",
	invalid: "请检查输入：大小需为正数，边距可为任意数字。",
	busy: "保存中…",
	extraPetsHint: "另 {n} 只额外宠物由 pet/ 目录文件定义（<名>-config.json + <名>-animation/ + <名>-memes/），它们不在此列表——改文件后浏览器刷新页面、桌面端右键「重载配置」即可生效。",
	notifyToggle: "系统通知",
	notifyToggleHint: "对话完成 / 生成失败 / 权限申请 / 用户选择，在窗口失焦时弹出系统级通知（桌面右下角）。",
	whisperImageToggle: "碎碎念配图",
	whisperImageToggleHint: "碎碎念时从表情包池随机抽一张，连同那句话一起显示（图片映射在配置文件顶层 memes）。token：碎碎念本来就每次生成都要调一次模型，配图只是把抽中那张的名称+描述（约 100 字符 / ≈60 token）加进同一次请求，增量可忽略。",
	chatImageToggle: "对话配图",
	chatImageToggleHint: "对话时由 AI 按当前语境从表情包池挑一张配图（可不挑；图片映射在配置文件顶层 memes）。token：每条消息都要把整张清单附进请求，当前约 1.1k 字符（≈650 token，约碎碎念配图的 11 倍），并随图片数量线性增长；关掉则一个字符都不附。",
	confineToggle: "抛掷锁定在当前屏幕",
	confineToggleHint: "多屏用户：甩出去的宠物只在松手时所在那块屏幕内弹（屏缝当墙，不飞到隔壁屏）；关掉则照常跨屏飞行。只影响桌面模式——浏览器 overlay 本来就只在视口内弹。",
	physicsTitle: "物理（拖拽抛掷手感）",
	voiceTitle: "语音对话",
	voiceHint: "识别用本机 SenseVoice（离线免费），合成用 edge-tts。这里改完点「保存语音设置」**立即生效**——语音配置单独存在 voice.json，不参与下面的「保存」。",
	voiceShortcutLabel: "按住说话的快捷键",
	voiceShortcutHint: "形如 Alt+V / Ctrl+Shift+Space / F8。按住说话、松开结束；播放中按下可打断。宿主会注册**系统级**热键：DSH 窗口在后台、最小化或被其他应用挡住时也能用（需要 DSH 主程序在运行，仅 Windows）。",
	voiceMicLabel: "麦克风设备",
	voiceMicDefault: "跟随系统默认",
	voiceMicRefresh: "重新检测",
	voiceMicHint: "选了就只从这台设备录音。设备名需要先授权麦克风才读得到，点「重新检测」会请求一次权限（不会录音）",
	voiceMicTest: "测试麦克风",
	voiceMicTestStop: "停止测试",
	voiceMicTestHint: "点「测试麦克风」后对着麦克风说两三秒话：电平条跟着动 = 设备在正常录入；说完会给结论。测试本身不录音、不发给模型。",
	voiceMicTestOk: "✅ 有声音，设备正常",
	voiceMicTestQuiet: "⚠️ 几乎没声音：检查设备是否选对、系统静音或麦克风被占用",
	voiceMicTestDenied: "麦克风权限被拒绝",
	voiceMicTestNotFound: "选定的麦克风不可用",
	voicePreview: "试听一句",
	voicePreviewLoading: "合成中…",
	voicePreviewPlayed: "已播放",
	voicePreviewHint: "会合成一句「主人，我是鲸鱼娘，能听到我吗？」并播出来。如果你看到「已播放 N 秒」却还是没声音，问题在**系统输出设备**（这台机器上有 Voicemeeter / VR / USB 等多个输出端点），不是插件。",
	voiceHideButton: "隐藏麦克风按钮",
	voiceHideButtonHint: "勾选后界面右下角那颗按钮不再显示，只用快捷键说话（快捷键可在上面改）。",
	sightTitle: "看屏幕搭话（主动识屏）",
	sightHint: "打开后，我会隔一段时间看一眼屏幕，看到值得说的就冒个气泡。默认关着——你不开，我绝不截图。",
	sightEnabled: "开启主动识屏",
	sightEnabledHint: "截图在本机压成约 120 KB 的 JPEG，用**你选的模型**识别（默认跟对话模型一致——选 workbuddy 就花积分，不烧官方 token）。图片只经一次临时中转，调用结束立刻删除；下面的快照是另存的审计副本，随时可查。",
	sightVisionModelLabel: "当前使用模型",
	sightIntervalLabel: "间隔（秒）",
	sightIntervalHint: "最短 15 秒。太频繁既费钱又吵。",
	sightKeepLabel: "快照保留张数",
	sightKeepHint: "存一份给你核对「我看了什么」。0 = 不留，最多 200 张，超了删最旧的。",
	sightSpeak: "顺便念出来",
	sightModeLabel: "观察模式",
	sightModeCompanion: "日常陪聊",
	sightModePlay: "陪玩（盯着战况）",
	sightModeWatch: "只看不说",
	sightModeHint: "三种模式只换提示词（间隔、张数、是否朗读等参数都共用）：日常陪聊随口搭话；陪玩盯着战局点评、给具体建议；只看不说只存快照、不调用模型，不打扰也不花钱。",
	sightJitterMinLabel: "间隔随机下限（倍）",
	sightJitterMaxLabel: "间隔随机上限（倍）",
	sightJitterHint: "实际间隔 = 基准秒数 × 这个区间里的随机数。0.6~1.6 表示有时 36 秒、有时 96 秒——比固定频率自然。",
	sightMemoryShared: "搭话也写入共享记忆",
	sightMemoryHint: "勾上后她看屏幕说的话也进同一份记忆，跟文字/语音对话连贯（推荐）。",
	sightSpeakHint: "不勾只弹气泡（推荐）；勾上会用语音念，像在耳边说话。",
	sightRunNow: "现在看一眼",
	sightRunning: "正在看…",
	sightRunSpoke: "她说了",
	sightRunSkipped: "这次没说话",
	sightRunFailed: "没看成",
	sightSave: "保存识屏设置",
	sightSaving: "保存中…",
	sightSaved: "已保存",
	sightSnapshots: "已留快照",
	voiceVisionLabel: "语音时主动看屏幕",
	voiceVisionOff: "从不（最省）",
	voiceVisionAuto: "提到才看（推荐）",
	voiceVisionAlways: "每次都看（最贵）",
	voiceVisionHint: "你说「我在干嘛」「看这个」这类话时，她会自己看一眼再回答。auto 档只在话里提到相关词时才看。",
	voiceFramesLabel: "连拍帧数",
	voiceFramesHint: "1 张 = 最省，只能看静态；3~5 张能对比出画面在怎么变化（钱也按张数涨）。",
	voiceGapLabel: "帧间隔（毫秒）",
	voiceGapHint: "太短看不出变化，太长跟不上。700 毫秒适合大多数场景。",
	page_pet: "宠物",
	appsTitle: "应用名单",
	appsHint: "她能打开哪些程序。每行「名字=可执行名」，可自己增减。可执行名是 Start-Process 认的名字（如 WeChat、cloudmusic、msedge）。",
	appsSave: "保存名单",
	appsReload: "重新读取",
	appsSaved: "已保存，立即生效",
	appsFailed: "保存失败",
	wsTitle: "鲸鱼娘工作区",
	wsHint: "这里是她自己的面板：本局进度、开关状态、急停。详细设置在「设置 → 桌宠配置」。",
	wsNoSession: "还没开始本局",
	wsSteps: "步",
	wsSight: "主动识屏",
	wsAutoplay: "允许代打",
	wsOn: "：开",
	wsOff: "：关",
	wsEstop: "急停",
	wsReady: "就绪",
	wsStopped: "已停止",
	wsRun: "跑一轮",
	wsEnd: "结束本局",
	wsRunning: "思考中…",
	wsPlanned: "打算",
	wsSkipped: "跳过",
	wsFailed: "没成功",
	wsNothing: "这局还没记录什么",
	gameTitle: "游戏档案",
	gameHint: "视觉模型只看像素，不可能自己知道「W 是前进」。键位与要点必须写在这里——否则她只能瞎点。",
	gameNameLabel: "游戏名",
	gameNameHint: "填窗口标题里的名字，方便对得上。",
	gameGenreLabel: "类型",
	gameGenreHint: "类型决定默认键位与记忆容量（大战略记得更多）。",
	gameGenreTurn: "回合制",
	gameGenreStrategy: "大战略",
	gameGenreTactics: "战棋",
	gameGenreRpg: "RPG",
	gameGenreAction: "动作（速度受限）",
	gameGenreCustom: "自定义",
	gameKeysLabel: "键位（每行 动作=键）",
	gameKeysHint: "键名用英文：w a s d space enter esc tab up down left right 0-9。留空的沿用类型预设。",
	gameNotesLabel: "攻略要点（每行一条）",
	gameNotesHint: "写你希望她记住的关键决策，比如「前期优先科研」。",
	gameCapLabel: "本局记忆容量（步）",
	gameCapHint: "留空就用类型预设。玩一局要记多少步决定她记不记得住前面的局势。",
	gameCapPreset: "当前类型预设",
	gameSave: "保存档案",
	gameSaved: "档案已保存",
	gameGuide: "联网查攻略",
	gameGuideBusy: "正在查…",
	gameGuideDone: "查到了",
	gameGuideFailed: "没查到",
	gameNeedName: "先填游戏名再查",
	sessionTitle: "本局进度",
	sessionNone: "还没开始——点「跑一轮」开始记录",
	sessionEnd: "结束本局（记忆压缩）",
	sessionNothing: "这局还没记录什么",
	sessionEnded: "本局已收进记忆",
	page_look: "外观",
	saving: "保存中…",
	saveAll: "保存全部",
	saveAllDone: "全部已保存",
	saveAllHint: "一次写入全部四份配置（宠物 / 语音 / 识屏 / 代打），与当前在哪一页无关。",
	page_voice: "语音",
	page_sight: "看屏幕",
	page_play: "代打",
	page_more: "存储",
	page_log: "对话记录",
	chatlogTitle: "对话记录（只给你看）",
	chatlogHint: "完整来往，包括被拆出去的动作/神态（气泡里只保留台词）。和记忆分开：不参与模型上下文，只供随时翻阅。",
	chatlogRefresh: "刷新",
	chatlogExport: "导出",
	chatlogClear: "清空",
	chatlogClearConfirm: "清空这只桌宠的对话记录？记忆不受影响，但记录不可恢复（建议先导出）。",
	chatlogCleared: "已清空",
	chatlogEmpty: "还没有记录。聊几句就会出现在这里。",
	chatlogLoading: "加载中…",
	chatlogLoadFailed: "加载失败，稍后再试",
	chatlogLoadMore: "加载更早",
	playTitle: "代打（自己玩游戏）",
	playHint: "开启后她会看屏幕、决定下一步操作，并且**真的按下去**。默认空跑：只打印打算做什么，不动你的键鼠。",
	playEnabled: "允许代打",
	playEnabledHint: "总开关。关着时「跑一轮」也不会有任何动作。",
	playOn: "已允许",
	playOff: "未允许",
	playDryRun: "空跑模式",
	playDryHint: "开着只记录「打算做什么」，不真的按键。建议先空跑几轮确认判断合理。",
	playDryOn: "空跑（安全）",
	playDryOff: "真注入（危险）",
	playEstopKey: "急停键",
	playEstopHint: "随时按这个键立刻撒手。F12 最安全（游戏中几乎不占用）。",
	playEstopState: "急停状态",
	playEstopReady: "就绪",
	playEstopStopped: "已停止",
	playEstopResumeHint: "停止后会一直停着，必须点「恢复」才会再动——这是故意的。",
	playResume: "恢复（我允许她继续）",
	playWindows: "允许动手的窗口",
	playWindowsHint: "每行一个窗口标题（包含即可匹配）。前台窗口不匹配时一律拒绝——防止她把按键打进微信或浏览器。留空 = 不限制（不推荐）。",
	playCheckWindow: "看看现在前台是什么",
	playAddWindow: "把当前前台加入白名单",
	playPickWindow: "从运行中的窗口选择…",
	playRefreshWindows: "刷新窗口列表",
	playVisionModel: "代打用的识图模型",
	playVisionFollow: "跟随对话模型（默认）",
	playVisionPickModel: "选择模型…",
	playVisionHint: "对话模型如果偏重推理，一轮会很慢（实测 45~60 秒，还可能只想不答）。代打建议单独选一个「快、支持图片」的模型；留空 = 跟随对话模型。",
	playSave: "保存代打设置",
	playStart: "开始陪玩（她自己一局一局玩下去）",
	playStop: "停止陪玩",
	playLoopOn: "陪玩进行中：右下角有状态气泡；动一下键鼠或按急停键会停",
	playRunNow: "跑一轮",
	playRunning: "思考中…",
	playLog: "动作日志（最近 30 条）",
	playLogEmpty: "还没有记录。点「跑一轮」试一次空跑。",
	voiceNameLabel: "音色",
	voiceNameHint: "edge-tts 的音色名，默认 zh-CN-XiaoyiNeural（晓伊）",
	voiceSave: "保存语音设置",
	voiceSaving: "保存中…",
	voiceHotkeyRunning: "全局热键正在运行（{{shortcut}}）：DSH 在后台、最小化或被其他应用挡住时也能用",
	voiceHotkeyFailed: "全局热键还没生效：{{message}}（页面有焦点时快捷键仍然可用）",
	personaTitle: "人设（自定义）",
	personaHint: "留空 = 用配置文件里的默认人设。这里写的内容会覆盖 main 条目的 whisperPrompt（碎碎念与对话共用同一份人设）。",
	personaPlaceholder: "你是一只住在主人桌面上的鲸鱼娘……",
	personaSave: "保存人设",
	personaSaved: "人设已保存（下一句生效，不用重启）",
	personaUsingFile: "当前使用：你自己写的人设（persona.json）",
	personaUsingConfig: "当前使用：配置文件里的默认人设",
	memoryTitle: "对话记忆（导入 / 导出）",
	memoryHint: "当前 {{count}} 条。支持粘贴 JSON 数组（[{role,content}]）、{messages:[…]}，或「我：… / 你：…」一行一句的纯文本；导入会按时间合并去重。注意：每次对话只带最近 N 轮（设置里的「对话记忆轮数」）。",
	memoryPlaceholder: "把手机端导出的聊天记录粘贴到这里，或点「选择文件」…",
	memoryImport: "导入记忆",
	memoryExport: "导出记忆",
	memoryClear: "清空记忆",
	memoryEmpty: "先粘贴内容或选择文件",
	memoryImported: "导入完成：新增 {{added}} 条，共 {{total}} 条",
	memoryCleared: "已清空",
	memoryClearConfirm: "确定要清空这只桌宠的全部对话记忆吗？清空后不可恢复（建议先导出）。",
	memoryExportFailed: "导出失败，稍后再试",
	voiceSaved: "已保存，快捷键与全局热键立即生效",
	physicsHint: "全局默认，所有宠物共用（pet pack 可在自己种类文件里单独覆盖）；随「保存」写入用户配置（不做即时写入）。浏览器保存后即时生效，桌面端由保存重载宠物窗口后生效。",
	"physics.gravity": "重力 gravity",
	"physics.gravityHint": "px/s²，越大落得越快；0 = 无重力（抛出去匀速直线飞）",
	"physics.restitution": "弹性 restitution",
	"physics.restitutionHint": "0~1，碰壁 / 落地反弹保留的速度比例（1 = 完全弹性，0 = 撞上即停）",
	"physics.groundFriction": "地面摩擦 groundFriction",
	"physics.groundFrictionHint": "/s，落地后水平速度的衰减率；0 = 冰面不减速",
	"physics.throwPower": "总力度 throwPower",
	"physics.throwPowerHint": "> 0，弹簧跟手与甩出初速的整体倍率（1 = 默认；越大越跟手、甩得越猛）",
	physicsCeilingBounce: "顶部反弹 ceilingBounce",
	physicsCeilingBounceHint: "关掉后抛掷可飞出屏幕顶部（重力仍会把它拉回来）",
	physicsPetCollision: "宠物互撞 petCollision",
	physicsPetCollisionHint: "飞行中的宠物撞到别的宠物按动量守恒弹开（质量 ∝ 尺寸²）",
	invalidPhysics: "请检查物理参数：重力 / 地面摩擦 ≥ 0，弹性 0~1，总力度 > 0。",
	fontTitle: "外观与字体",
	fontHint: "字体种类作用于现在用软糖体的全部文字：宠物气泡、悬浮提示、对话窗、得分弹窗；字号只作用于宠物气泡与悬浮提示（对话窗与得分弹窗的字号不变）。全局默认，所有宠物共用（pet pack 可在自己种类文件里单独覆盖）；随「保存」写入用户配置，浏览器保存后即时生效，桌面端由保存重载宠物窗口后生效。",
	fontFamilyLabel: "字体",
	fontFamilyHint: "「软糖体（内置）」随插件提供；其余为系统字体，机器上没装时自动回退到字体栈里的下一个（不会空白或报错）。",
	fontSizeLabel: "字号（px）",
	fontSizeHint: "气泡正文字号；悬浮提示与气泡内的小字按既有比例派生。范围 4~200。",
	fontFollowToggle: "字号随宠物大小缩放",
	fontFollowToggleHint: "开启（默认）：宠物调大时字号等比放大，462 宽时正好是上面设定的字号；关闭：字号恒定，不随宠物大小变化。",
	invalidFont: "请检查字体设置：字体需在下拉列表内，字号需为 4~200 的数字。",
	"font.candy": "软糖体（内置）",
	"font.yahei": "微软雅黑 / 苹方",
	"font.youyuan": "幼圆",
	"font.kaiti": "楷体",
	"font.simsun": "宋体",
	"font.comic": "漫画体",
	"font.system": "系统默认",
	modelTitle: "AI 模型与对话上下文",
	modelHint: "这一个模型同时用于文字对话、语音对话、看屏幕搭话与代打——它们都是同一个「她」。选「跟随当前对话」= 用你当前对话正在用的那个（默认）。选项与 DSH 的模型选择器同源，由宿主实时提供。",
	modelSharedHint: "文字对话 / 语音对话 / 看屏幕搭话 / 代打都用这一个模型，改一处全部跟着变。",
	modelFollow: "跟随当前对话",
	modelSearch: "搜索模型…",
	modelEmpty: "没有匹配的模型。",
	modelNoModels: "没有可用的模型。",
	modelLoading: "正在刷新模型列表…",
	modelTriggerAria: "选择模型，当前 {model}",
	modelUnknown: "（当前配置，不在列表中）",
	modelNone: "该服务商没有可用模型",
	whisperModelLabel: "碎碎念模型",
	chatModelLabel: "对话模型",
	modelFieldHint: "选「跟随当前对话」= 用当前对话的模型；指定了但调用失败会自动回落到当前对话的模型重试一次。",
	invalidModel: "请检查模型设置：服务商与模型要么都选，要么都留空（跟随当前对话）。",
	modelCatalogFailed: "模型列表加载失败（刷新页面可重试）；当前配置值仍会原样保留。",
	chatMemory: "对话历史条数",
	chatMemoryHint: "每次对话请求携带的最近历史轮数（1 轮 = 1 问 1 答；0 = 不带历史，每句都是全新对话）。对话记忆本身全存不删，此值只决定截多少进上下文——越大越记得住，也越费 token。全局默认，所有宠物共用（pet pack 可在自己种类文件里单独覆盖）。",
	invalidChatMemory: "请检查对话历史条数：需为 ≥ 0 的数字。",
	chatImageLimit: "对话配图张数上限",
	chatImageLimitHint: "对话时发给模型的表情包清单最多几张（「前 N 张」= 配置里写在前面的那 N 条，想让哪几张优先被发出去就把顺序往前挪）。整张清单是每条消息都要附的，token 随张数线性增长——张数一多就是纯烧钱，限制成前 N 张，模型只从这几张里挑。0 = 不限制（全部发）。内置默认 10。全局默认，所有宠物共用（pet pack 可在自己种类文件里覆盖）。只影响对话选图：碎碎念只带抽中的那一张。",
	invalidChatImageLimit: "请检查对话配图张数上限：需为 ≥ 0 的数字（0 = 不限制）。",
	notifyTest: "测试弹窗",
	notifyTestOk: "测试通知已发送，请查看桌面右下角。",
	notifyDenyUnsupported: "当前环境不支持系统通知（浏览器无 Notification API）。",
	notifyDenyBlocked: "通知权限已被浏览器标记为「阻止」。",
	notifyDenyRejected: "你在权限询问弹窗中选择了「阻止」。",
	notifyDenyError: "申请权限时出错",
	notifyGuide: "引导：点击地址栏左侧 🔒/ⓘ →「网站设置」→「通知」→ 改为「允许」，刷新页面后重试。",
	storageTitle: "卸载与存储",
	storageHint: "插件在本机落下的全部位置。删缓存不影响使用（会自动重下/重建）；删「插件用户数据」会丢配置与对话记忆。",
	"storage.userData": "插件用户数据：自定义配置 main-config.jsonc、对话记忆 memory.json、自定义动画素材 main-animation/、文件宠物 pet/",
	"storage.electron": "桌面宠物用的 Electron 运行时（体积较大；删除后下次启用桌面模式会自动重新下载）",
	"storage.desktopCache": "桌面宠物窗口的缓存与主屏缩放缓存（可删，会自动重建）",
	"storage.electronCache": "Electron 安装包下载缓存（可删，需要时会重新下载）",
	"storage.package": "插件本体（由 DSH 管理，用下面的卸载命令移除，不要手删）",
	storageMissing: "（尚未创建）",
	uninstallTitle: "卸载方法",
	uninstallStep1: "1. 先退出 DSH（桌面宠物随之退出）；不要在桌宠运行时删除上面的文件。",
	uninstallStep2: "2. 卸载插件本体（终端执行，会同时从 profile 的 bundle 层移除）：",
	uninstallStep3: "3. 按需删除上面的位置：缓存类删了无影响；「插件用户数据」删了会丢配置与对话记忆（想保留就先备份其中的 main-config.jsonc）。",
	uninstallCmd: "dsh plugin --profile {profile} remove dsh-whale-girl"
};
const en = {
	nav: "Pet Config",
	intro: "Manage multiple pets: each pet has its own size and position (applies instantly after saving).",
	petCardTitle: "Pet",
	petCardHint: "Per-pet settings: name / size / display / corner / offsets / the four feature switches. Click \"Save\" at the bottom to apply instantly.",
	globalTitle: "Global switches",
	globalHint: "Shared by every pet (a pet pack may override them in its own kind file). These switches only change local state and are written to the user config on \"Save\" (never written immediately); system notifications re-read right after saving, no page refresh needed.",
	cornerHint: "Which screen corner the pet sticks to (per-monitor work area in desktop mode).",
	marginXHint: "Horizontal distance from the chosen corner (px); any number.",
	marginYHint: "Vertical distance from the chosen corner (px); any number.",
	"cmd.chat": "Chat",
	"cmd.pet": "Pet",
	"cmd.balance": "Balance",
	petsLabel: "Pets",
	add: "Add pet",
	remove: "Remove",
	confirmRemove: "Delete pet \"{id}\"?",
	confirmTitle: "Confirm action",
	cancel: "Cancel",
	ok: "Got it",
	atLeastOne: "Keep at least one pet.",
	emptyPets: "No pets yet — click \"Add pet\" to create one.",
	sizeLabel: "Size (width px)",
	sizeHint: "Height is automatic = width × 9/16.",
	nameLabel: "Name",
	nameHint: "Shown on hover and added to AI personas (\"your name is X\"). Duplicates allowed; empty falls back to the pet id.",
	balanceEnabled: "Balance",
	balanceEnabledHint: "When enabled, this pet plays balance animations and shows the balance bubble.",
	whisperEnabled: "Whisper",
	whisperEnabledHint: "When enabled, this pet periodically generates a line via AI and plays the whisper animation (persona & interval live in the top-level config).",
	workStatusEnabled: "Work status",
	workStatusEnabledHint: "When enabled, this pet follows DSH work state: thinking / working / waiting / done / error switch animations and show bubbles (pool in top-level config; listening only, no model calls).",
	fixedEnabled: "Pin in place",
	fixedEnabledHint: "When enabled, the random chain no longer turns this pet or walks it away — only idle and in-place actions play. Right-click picks, API triggers and balance / whisper / work-status animations are unaffected.",
	displayLabel: "Display",
	displayHint: "web = browser only / desktop = desktop only / both = both / none = neither",
	"display.web": "Browser only",
	"display.desktop": "Desktop only",
	"display.both": "Both",
	"display.none": "Neither",
	cornerLabel: "Position",
	"corner.top-left": "Top-left",
	"corner.top-right": "Top-right",
	"corner.bottom-left": "Bottom-left",
	"corner.bottom-right": "Bottom-right",
	marginX: "Horizontal offset",
	marginY: "Vertical offset",
	save: "Save",
	sync: "Sync",
	confirmSync: "Sync? This overwrites the user config with the bundled default config (all fields + comments); current customizations are lost.",
	corruptTitle: "User config is corrupted — not saved",
	corruptConfirm: "Save anyway",
	corruptBody: "The user config file cannot be parsed (corrupted, not valid JSON/JSONC): {path}. Saving now rebuilds it from the whitelist — everything currently in that file (animations / physics / memes …) will be lost. Cancel = leave the file untouched (fix it and save again); Confirm = save anyway (discard what is in the file).",
	syncHint: "\"Sync\" writes the bundled default config (comments + every advanced field included) to the user config file, overwriting your current customizations; the file is then directly editable. Two caveats: (1) once created, that file is an explicit override layer — later changes to the bundled defaults will not take effect automatically (until you sync again or delete the file); (2) clicking \"Save\" on this page rewrites the file from a whitelist — field values are kept, comments are dropped.",
	configMeta: "Advanced (files)",
	configMetaHint: "User config may override pets / animation pools / weights — refresh or restart to apply: refresh the page in the browser, or right-click a desktop pet → \"Reload config\" (rebuilds every desktop pet window). The default config is the complete reference.",
	defaultConfig: "Default config (read-only, complete reference)",
	userConfig: "User config (custom overrides)",
	animationDir: "Animation assets dir (add/customize animations here)",
	memesDir: "Meme images dir (add/customize images here)",
	saved: "Saved — the pets updated instantly.",
	loadError: "Failed to load config",
	loading: "Loading config…",
	retry: "Retry",
	invalid: "Check your input: size must be positive; margins can be any number.",
	busy: "Saving…",
	extraPetsHint: "{n} extra pet(s) are file-defined in the pet/ directory (<name>-config.json + <name>-animation/ + <name>-memes/). They are not in this list — after editing the files, refresh the page (browser) or right-click a desktop pet → \"Reload config\".",
	notifyToggle: "System notifications",
	notifyToggleHint: "OS-level toasts (bottom-right of the desktop) for conversation completion, failures, permission requests, and questions — only while this window is unfocused.",
	whisperImageToggle: "Whisper images",
	whisperImageToggleHint: "Attach one random meme from the pool to each whisper line (image mapping lives in the top-level `memes` config field). Tokens: a whisper already calls the model every cycle, so the image only appends the name + description of that one meme (~100 chars / ~60 tokens) to the same request — negligible.",
	chatImageToggle: "Chat images",
	chatImageToggleHint: "Let the AI pick one meme from the pool that fits the current context (optional; mapping lives in the top-level `memes` config field). Tokens: every message carries the whole catalog — currently ~1.1k chars (~650 tokens, about 11x the whisper case) and growing with the number of images; turning this off appends nothing at all.",
	confineToggle: "Lock throws to the current screen",
	confineToggleHint: "Multi-monitor: a thrown pet bounces only inside the screen it was released on (screen seams act as walls, so it never flies to the neighbouring monitor); turn this off to let it cross screens as usual. Desktop only — the browser overlay always bounces inside the viewport anyway.",
	physicsTitle: "Physics (drag & throw feel)",
	voiceTitle: "Voice chat",
	voiceHint: "Recognition uses the on-device SenseVoice model (offline, free); speech uses edge-tts. Changes here take effect immediately via \"Save voice settings\" — voice config lives in voice.json and is not part of the main Save below.",
	voiceShortcutLabel: "Push-to-talk shortcut",
	voiceShortcutHint: "Such as Alt+V / Ctrl+Shift+Space / F8. Hold to talk, release to finish; press again while speaking to interrupt. The host registers a system-wide hotkey, so it also works while DSH is in the background, minimized, or covered by another app (DSH must be running; Windows only).",
	voiceMicLabel: "Microphone",
	voiceMicDefault: "Follow system default",
	voiceMicRefresh: "Rescan",
	voiceMicHint: "Recording uses only this device. Device names require microphone permission — Rescan asks once (it does not record)",
	voiceMicTest: "Test microphone",
	voiceMicTestStop: "Stop test",
	voiceMicTestHint: "Click \"Test microphone\" and speak for two or three seconds: a moving level bar means the device records. A verdict follows. The test does not record or send anything.",
	voiceMicTestOk: "✅ Sound detected — device works",
	voiceMicTestQuiet: "⚠️ Almost silent: check the device, system mute, or another app holding the mic",
	voiceMicTestDenied: "Microphone permission denied",
	voiceMicTestNotFound: "Selected microphone unavailable",
	voicePreview: "Play a sample",
	voicePreviewLoading: "Synthesizing…",
	voicePreviewPlayed: "Played",
	voicePreviewHint: "Synthesizes and plays one sample sentence. If it says \"Played N s\" but you hear nothing, the problem is your **system output device** (this machine exposes Voicemeeter / VR / USB endpoints), not the plugin.",
	voiceHideButton: "Hide the microphone button",
	voiceHideButtonHint: "When checked, the floating button disappears; you talk via the shortcut only (configurable above).",
	sightTitle: "Screen awareness (proactive)",
	sightHint: "When enabled, I peek at your screen every so often and pop a bubble if something is worth saying. Off by default — I never screenshot unless you turn it on.",
	sightEnabled: "Enable screen awareness",
	sightEnabledHint: "The screenshot is compressed locally to ~120 KB JPEG and recognised by **the model you picked** (defaults to your chat model — pick workbuddy and it spends credits, not official tokens). The image passes through one temporary hop that is deleted right after the call; the snapshot below is a separate audit copy you can inspect anytime.",
	sightVisionModelLabel: "Model in use",
	sightIntervalLabel: "Interval (seconds)",
	sightIntervalHint: "Minimum 15s. Shorter is noisy and costs more.",
	sightKeepLabel: "Snapshots to keep",
	sightKeepHint: "A local copy so you can audit what I saw. 0 = keep none, max 200, oldest dropped first.",
	sightSpeak: "Speak it aloud",
	sightModeLabel: "Observation mode",
	sightModeCompanion: "Companion",
	sightModePlay: "Co-op (reads the fight)",
	sightModeWatch: "Observe silently",
	sightModeHint: "The three modes only swap the prompt (interval, frames, speak and other settings are shared): Companion chats casually; Co-op reads the match and gives concrete advice; Observe silently only saves snapshots without calling the model, so it costs nothing and never interrupts.",
	sightJitterMinLabel: "Jitter lower bound (×)",
	sightJitterMaxLabel: "Jitter upper bound (×)",
	sightJitterHint: "Actual delay = base seconds × a random factor in this range. 0.6–1.6 means sometimes 36s, sometimes 96s — more natural than a fixed rate.",
	sightMemoryShared: "Write into shared memory",
	sightMemoryHint: "When checked, what she says about the screen enters the same memory as text/voice chat, so she stays coherent (recommended).",
	sightSpeakHint: "Unchecked = bubble only (recommended). Checked = also read aloud.",
	sightRunNow: "Look now",
	sightRunning: "Looking…",
	sightRunSpoke: "She said",
	sightRunSkipped: "Nothing to say this time",
	sightRunFailed: "Could not look",
	sightSave: "Save screen settings",
	sightSaving: "Saving…",
	sightSaved: "Saved",
	sightSnapshots: "Snapshots kept",
	voiceVisionLabel: "Look at screen during voice chat",
	voiceVisionOff: "Never (cheapest)",
	voiceVisionAuto: "When mentioned (recommended)",
	voiceVisionAlways: "Every turn (priciest)",
	voiceVisionHint: "When you say things like \"what am I doing\" or \"look at this\", she peeks first and then answers. Auto only looks when the words suggest it.",
	voiceFramesLabel: "Burst frames",
	voiceFramesHint: "1 = cheapest, a single still; 3–5 lets her compare how the screen changes (cost scales with frames).",
	voiceGapLabel: "Frame gap (ms)",
	voiceGapHint: "Too short hides motion, too long misses it. 700 ms fits most cases.",
	page_pet: "Pet",
	appsTitle: "App name list",
	appsHint: "Which programs she can open. One \"name=executable\" per line; add or remove freely. Use the name Start-Process accepts (e.g. WeChat, cloudmusic, msedge).",
	appsSave: "Save list",
	appsReload: "Reload",
	appsSaved: "Saved, effective immediately",
	appsFailed: "Save failed",
	wsTitle: "Whale Girl workspace",
	wsHint: "Her own panel: session progress, toggles, e-stop. Detailed settings live in Settings → Pet configuration.",
	wsNoSession: "No session yet",
	wsSteps: "steps",
	wsSight: "Screen awareness",
	wsAutoplay: "Autoplay allowed",
	wsOn: ": on",
	wsOff: ": off",
	wsEstop: "E-stop",
	wsReady: "ready",
	wsStopped: "stopped",
	wsRun: "Run one step",
	wsEnd: "End session",
	wsRunning: "Thinking…",
	wsPlanned: "Plan",
	wsSkipped: "Skipped",
	wsFailed: "Failed",
	wsNothing: "Nothing recorded this session",
	gameTitle: "Game profile",
	gameHint: "A vision model sees pixels only — it cannot know W means forward. Write the keys and notes here, or she will just click blindly.",
	gameNameLabel: "Game name",
	gameNameHint: "Use the name in the window title so it can be matched.",
	gameGenreLabel: "Genre",
	gameGenreHint: "Genre decides preset keys and memory capacity (grand strategy remembers more).",
	gameGenreTurn: "Turn-based",
	gameGenreStrategy: "Grand strategy",
	gameGenreTactics: "Tactics",
	gameGenreRpg: "RPG",
	gameGenreAction: "Action (speed-limited)",
	gameGenreCustom: "Custom",
	gameKeysLabel: "Keys (action=key per line)",
	gameKeysHint: "Use English key names: w a s d space enter esc tab up down left right 0-9. Blank entries fall back to the genre preset.",
	gameNotesLabel: "Strategy notes (one per line)",
	gameNotesHint: "Things you want her to remember, e.g. \"prioritise research early\".",
	gameCapLabel: "Session memory capacity (steps)",
	gameCapHint: "Leave empty to use the genre preset. How many steps she remembers decides whether she can recall the earlier game state.",
	gameCapPreset: "Genre preset",
	gameSave: "Save profile",
	gameSaved: "Profile saved",
	gameGuide: "Look up a guide",
	gameGuideBusy: "Searching…",
	gameGuideDone: "Found",
	gameGuideFailed: "Nothing found",
	gameNeedName: "Enter a game name first",
	sessionTitle: "This session",
	sessionNone: "Not started — hit \"Run one step\" to begin recording",
	sessionEnd: "End session (compress memory)",
	sessionNothing: "Nothing recorded in this session",
	sessionEnded: "Session folded into memory",
	page_look: "Look",
	saving: "Saving…",
	saveAll: "Save all",
	saveAllDone: "All saved",
	saveAllHint: "Writes all four config files at once (pet / voice / sight / autoplay), regardless of which tab you are on.",
	page_voice: "Voice",
	page_sight: "Sight",
	page_play: "Autoplay",
	page_more: "Storage",
	page_log: "Chat log",
	chatlogTitle: "Chat log (for your eyes only)",
	chatlogHint: "Full exchanges, including the action/expression lines split out of the chat bubble. Separate from memory: never sent to the model, just for browsing.",
	chatlogRefresh: "Refresh",
	chatlogExport: "Export",
	chatlogClear: "Clear",
	chatlogClearConfirm: "Clear this pet chat log? Memory is unaffected, but the log cannot be recovered (export first).",
	chatlogCleared: "Cleared",
	chatlogEmpty: "No entries yet. Chat a little and it will show up here.",
	chatlogLoading: "Loading…",
	chatlogLoadFailed: "Failed to load, try again later",
	chatlogLoadMore: "Load older",
	playTitle: "Autoplay (plays games itself)",
	playHint: "When enabled she looks at the screen, decides the next action, and **actually presses it**. Dry run is on by default: it only prints the plan.",
	playEnabled: "Allow autoplay",
	playEnabledHint: "Master switch. When off, \"Run one step\" performs no action at all.",
	playOn: "Allowed",
	playOff: "Not allowed",
	playDryRun: "Dry run",
	playDryHint: "Only records what she would do; never touches your input. Run a few dry rounds first.",
	playDryOn: "Dry run (safe)",
	playDryOff: "Real injection (risky)",
	playEstopKey: "Emergency stop key",
	playEstopHint: "Press anytime to take over instantly. F12 is safest (rarely used by games).",
	playEstopState: "E-stop state",
	playEstopReady: "Ready",
	playEstopStopped: "Stopped",
	playEstopResumeHint: "Stays stopped until you explicitly resume — that is deliberate.",
	playResume: "Resume (I allow her to continue)",
	playWindows: "Windows where she may act",
	playWindowsHint: "One window title per line (substring match). Any mismatch refuses the action — prevents typing into chat apps. Empty = no restriction (not recommended).",
	playCheckWindow: "What is in front right now?",
	playAddWindow: "Add the front window to the allowlist",
	playPickWindow: "Pick a running window…",
	playRefreshWindows: "Refresh windows",
	playVisionModel: "Vision model for autoplay",
	playVisionFollow: "Follow chat model (default)",
	playVisionPickModel: "Pick a model…",
	playVisionHint: "A heavy reasoning chat model makes each round slow (45–60 s measured, sometimes thinking without an answer). Pick a fast image-capable model for autoplay; empty = follow the chat model.",
	playSave: "Save autoplay settings",
	playStart: "Start playing (round after round)",
	playStop: "Stop playing",
	playLoopOn: "Autoplay running — status pill at bottom-right; any input or the estop key stops it",
	playRunNow: "Run one step",
	playRunning: "Thinking…",
	playLog: "Action log (last 30)",
	playLogEmpty: "No entries yet. Hit \"Run one step\" for a dry round.",
	voiceNameLabel: "Voice",
	voiceNameHint: "edge-tts voice name; default zh-CN-XiaoyiNeural",
	voiceSave: "Save voice settings",
	voiceSaving: "Saving…",
	voiceHotkeyRunning: "Global hotkey is running ({{shortcut}}): works while DSH is in the background, minimized, or covered",
	voiceHotkeyFailed: "Global hotkey is not active: {{message}} (the shortcut still works while this page has focus)",
	personaTitle: "Persona (custom)",
	personaHint: "Empty = use the default persona from the config file. What you write here overrides the main entry whisperPrompt (shared by idle chatter and chat).",
	personaPlaceholder: "You are a whale girl living on the master desktop…",
	personaSave: "Save persona",
	personaSaved: "Persona saved (applies to the next reply, no restart)",
	personaUsingFile: "In use: your custom persona (persona.json)",
	personaUsingConfig: "In use: the default persona from the config file",
	memoryTitle: "Chat memory (import / export)",
	memoryHint: "{{count}} messages. Paste a JSON array ([{role,content}]), a {messages:[…]} object, or plain lines like \"Me: … / You: …\". Imports are merged and de-duplicated by time. Note: each chat only carries the most recent N rounds (the chat memory rounds setting).",
	memoryPlaceholder: "Paste the chat export from your phone here, or choose a file…",
	memoryImport: "Import memory",
	memoryExport: "Export memory",
	memoryClear: "Clear memory",
	memoryEmpty: "Paste something or choose a file first",
	memoryImported: "Imported: {{added}} added, {{total}} total",
	memoryCleared: "Cleared",
	memoryClearConfirm: "Clear all chat memory for this pet? This cannot be undone (export first).",
	memoryExportFailed: "Export failed, try again later",
	voiceSaved: "Saved — the shortcut and global hotkey apply immediately",
	physicsHint: "Global default, shared by every pet (a pet pack may override it in its own kind file); written to the user config on \"Save\" (never written immediately). Applies instantly in the browser; on the desktop it applies once Save reloads the pet windows.",
	"physics.gravity": "Gravity",
	"physics.gravityHint": "px/s² — the higher, the faster it falls; 0 = weightless (flies straight forever)",
	"physics.restitution": "Bounciness",
	"physics.restitutionHint": "0–1, speed kept when bouncing off a wall or the floor (1 = perfectly elastic, 0 = stops dead)",
	"physics.groundFriction": "Ground friction",
	"physics.groundFrictionHint": "per second, horizontal damping while on the ground; 0 = frictionless ice",
	"physics.throwPower": "Throw power",
	"physics.throwPowerHint": "> 0, overall multiplier for spring tracking and release speed (1 = default; higher = tighter tracking, harder throws)",
	physicsCeilingBounce: "Ceiling bounce",
	physicsCeilingBounceHint: "Turn this off to let a throw fly out through the top of the screen (gravity still pulls it back)",
	physicsPetCollision: "Pet collisions",
	physicsPetCollisionHint: "A flying pet bounces off the others with momentum conservation (mass ∝ size²)",
	invalidPhysics: "Check the physics values: gravity / ground friction ≥ 0, bounciness 0–1, throw power > 0.",
	fontTitle: "Appearance & font",
	fontHint: "The family applies to every place that currently uses the candy font: pet bubble, hover tooltip, chat popup, score popup. The size applies only to the pet bubble and the hover tooltip (chat and score popups keep their own size). Global default, shared by every pet (a pet pack may override it in its own kind file); written to the user config on \"Save\" — instant in the browser, and on the desktop it applies once Save reloads the pet windows.",
	fontFamilyLabel: "Font",
	fontFamilyHint: "\"Candy (bundled)\" ships with the plugin; the others are system fonts. If a font is missing on this machine, it falls back to the next one in the stack (never blank, never an error).",
	fontSizeLabel: "Font size (px)",
	fontSizeHint: "Bubble body text size; the tooltip and the smaller lines inside the bubble scale proportionally. Range 4–200.",
	fontFollowToggle: "Scale font with pet size",
	fontFollowToggleHint: "On (default): the font grows with the pet — at 462 px width it is exactly the size above. Off: the size stays fixed regardless of pet size.",
	invalidFont: "Check the font settings: the family must be in the list and the size must be a number between 4 and 200.",
	"font.candy": "Candy (bundled)",
	"font.yahei": "Microsoft YaHei / PingFang",
	"font.youyuan": "YouYuan",
	"font.kaiti": "KaiTi",
	"font.simsun": "SimSun",
	"font.comic": "Comic Sans MS",
	"font.system": "System default",
	modelTitle: "AI models & chat context",
	modelHint: "This single model drives text chat, voice chat, screen awareness and autoplay — they are the same character. \"Follow current conversation\" reuses the model your conversation is on (default). Options come from the same source as the DSH model picker, served live by the host.",
	modelSharedHint: "Text chat, voice chat, screen awareness and autoplay all share this one model — change it once.",
	modelFollow: "Follow current conversation",
	modelSearch: "Search models…",
	modelEmpty: "No matching models.",
	modelNoModels: "No models available.",
	modelLoading: "Refreshing model list…",
	modelTriggerAria: "Select model, current {model}",
	modelUnknown: " (current config, not in the list)",
	modelNone: "No models available for this provider",
	whisperModelLabel: "Whisper model",
	chatModelLabel: "Chat model",
	modelFieldHint: "\"Follow current conversation\" uses the conversation model; if a chosen model fails, the plugin falls back to the conversation model and retries once.",
	invalidModel: "Check the model settings: pick both a provider and a model, or leave both empty (follow the current conversation).",
	modelCatalogFailed: "Failed to load the model list (refresh the page to retry); your current values are kept as they are.",
	chatMemory: "Chat history rounds",
	chatMemoryHint: "How many recent rounds each chat request carries (1 round = 1 question + 1 answer; 0 = no history, every message starts fresh). The memory itself keeps everything — this only decides how much goes into the context: higher remembers more and costs more tokens. Global default, shared by every pet (a pet pack may override it in its own kind file).",
	invalidChatMemory: "Check the chat history rounds: it must be a number ≥ 0.",
	chatImageLimit: "Chat image limit",
	chatImageLimitHint: "How many memes at most are listed to the model during chat (\"first N\" = the first N you wrote in the config, so move the ones you want sent to the front). That whole list is attached to every message and tokens grow linearly with the count, so a long list is pure burn; capping it to the first N makes the model pick only among those. 0 = no limit (send everything). Built-in default 10. Global default, shared by every pet (a pet pack may override it in its own kind file). Chat only — a whisper carries just the one meme it drew.",
	invalidChatImageLimit: "Check the chat image limit: it must be a number ≥ 0 (0 = no limit).",
	notifyTest: "Test notification",
	notifyTestOk: "Test notification sent — check the bottom-right of your desktop.",
	notifyDenyUnsupported: "System notifications are not supported in this environment (no Notification API).",
	notifyDenyBlocked: "Notification permission is blocked by the browser.",
	notifyDenyRejected: "You chose \"Block\" in the permission prompt.",
	notifyDenyError: "Failed to request permission",
	notifyGuide: "Guide: click the 🔒/ⓘ icon next to the address bar → Site settings → Notifications → set to \"Allow\", then refresh and retry.",
	storageTitle: "Uninstall & storage",
	storageHint: "Every location this plugin writes to. Deleting cache folders is harmless (they re-download / rebuild); deleting \"plugin user data\" loses your config and chat memory.",
	"storage.userData": "Plugin user data: custom config main-config.jsonc, chat memory memory.json, custom animation assets main-animation/, file pets pet/",
	"storage.electron": "Electron runtime used by the desktop pet (large; re-downloaded automatically the next time desktop mode starts)",
	"storage.desktopCache": "Desktop pet window cache and primary-monitor scale cache (safe to delete, rebuilt automatically)",
	"storage.electronCache": "Electron installer download cache (safe to delete, re-downloaded when needed)",
	"storage.package": "The plugin itself (managed by DSH — remove it with the command below instead of deleting it)",
	storageMissing: " (not created yet)",
	uninstallTitle: "How to uninstall",
	uninstallStep1: "1. Quit DSH first (the desktop pet exits with it); do not delete these files while the pet is running.",
	uninstallStep2: "2. Remove the plugin itself (run in a terminal; this also drops it from the profile bundle layer):",
	uninstallStep3: "3. Delete the locations above as needed: cache folders are harmless; deleting \"plugin user data\" loses your config and chat memory (back up main-config.jsonc first if you want to keep it).",
	uninstallCmd: "dsh plugin --profile {profile} remove dsh-whale-girl"
};
function makePetConfigSection(rt) {
	const { h, useState, useEffect, useRef, useCallback, t } = rt;
	injectSettingsCss();
	const CORNERS = [
		"top-left",
		"top-right",
		"bottom-left",
		"bottom-right"
	];
	const cornerLabel = (c) => t("corner." + c);
	const inputClass = "dsh-whale-girl-cfg__inp";
	/** 等宽字体栈（路径与命令展示用；不引外部字体，走系统栈，避免多拉一份资源） */
	const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, \"Courier New\", monospace";
	/** 生成一个未占用的宠物 id（pet-2、pet-3…） */
	const nextId = (list) => {
		let n = 2;
		for (;; n++) {
			const id = "pet-" + n;
			if (!list.some((p) => p.id === id)) return id;
		}
	};
	/**
	
	* 问号 + 悬浮说明（本页所有解释小字的唯一去处）。
	
	*
	
	* 为什么用 `<i>` 而不是 `<button>`：它只是说明入口，点了不该有任何行为，也不该被
	
	* Tab 当成操作项；真正的可交互入口是它旁边的输入框 / 开关。说明文字走 `data-tip`
	
	* 属性，由 SETTINGS_CSS 的 `::after{content:attr(data-tip)}` 画成气泡——CSS 才能
	
	* 表达 hover / 过渡，行内样式做不到。
	
	*
	
	* @param tip 说明正文（已翻译）
	
	* @param end 是否右对齐气泡（给栅格最右一列用，免得气泡顶出设置页）
	
	*/
	const q = (tip, end = false) => h("i", {
		className: "dsh-whale-girl-cfg__q" + (end ? " is-end" : ""),
		"data-tip": tip,
		"aria-label": tip,
		role: "img",
		children: "?"
	});
	/** 卡片头：标题 + 问号说明（+ 可选右侧动作，由调用方自行 append） */
	const cardHead = (title, tip, end = false) => h("div", {
		className: "dsh-whale-girl-cfg__cardHead",
		children: [h("span", {
			key: "t",
			className: "dsh-whale-girl-cfg__cardTitle",
			children: title
		}), tip ? q(tip, end) : null]
	});
	/** 一个字段：标签（+ 问号）在上、控件在下 */
	const field = (label, control, tip, end = false) => h("div", {
		className: "dsh-whale-girl-cfg__field",
		children: [h("span", {
			key: "l",
			className: "dsh-whale-girl-cfg__flabel",
			children: tip ? [label, q(tip, end)] : label
		}), control]
	});
	/**
	
	* 开关的一格：勾选框 + 标题 + 问号。
	
	* label 为文案键：标题 = t(label)，说明 = t(label + 'Hint')（说明进问号，不再占一行小字）。
	
	* 说明挂在问号上而不是整格——点标题只切开关，看说明去点问号，两个动作不再抢同一次点击。
	
	*/
	const toggleCell = (label, value, disabled, onToggle, end = false) => h("div", {
		className: "dsh-whale-girl-cfg__toggle",
		children: [h("label", {
			key: "l",
			children: [h("input", {
				key: "i",
				type: "checkbox",
				checked: value,
				disabled,
				onChange: (e) => onToggle(e.target.checked)
			}), h("span", {
				key: "t",
				children: t(label)
			})]
		}), q(t(label + "Hint"), end)]
	});
	/**
	
	* 「模型」单下拉选择器（碎碎念 / 对话各一个实例）——照 DSH 对话框右下角的模型选择器写：
	
	* 一个触发器按钮（当前模型 + 服务商小字 + 箭头）→ 点开一个浮层：搜索框 + 按服务商分组的
	
	* 模型清单（选中项打勾），最上面一项是「跟随当前对话」。
	
	*
	
	* 与 DSH 那份的对应关系：
	
	*  - 触发器 aria-haspopup/aria-expanded、浮层 role=menu、分组头 + role=menuitemradio[aria-checked]、
	
	*    搜索 role=searchbox —— 无障碍语义一致；
	
	*  - 浮层 position:fixed（脱离设置页滚动容器，不被 overflow 裁掉）+ 外部点击 / Esc 关闭 + 滚动跟随；
	
	*  - 搜索是**大小写不敏感的有序子序列**匹配（DSH 同款：输入 dsc 能命中 DeepSeek Chat）；
	
	*  - 数据来自 GET /models（宿主 llm 服务），与 DSH 模型选择器同一份来源。
	
	*
	
	* 为什么不用两个 <select>：DSH 自己就是"一个按钮 → 一个浮层里的分组清单"，两个下拉框既占地方，
	
	* 又容易留下"选了服务商没选模型"的非法组合。这里也**不再提供**"手填模型 id"的退路：
	
	* 列不出模型的服务商本来也没法调用，列出来只会诱人踩坑。
	
	*
	
	* 定义在工厂作用域（而非 PetConfigSection 内）：组件类型必须跨渲染稳定，否则每次渲染都会
	
	* 重新挂载，浮层状态（打开/搜索词/高亮）会当场丢失。
	
	*/
	const ModelPicker = (props) => {
		const [open, setOpen] = useState(false);
		const [query, setQuery] = useState("");
		const [active, setActive] = useState(0);
		const [pos, setPos] = useState(null);
		const rootRef = useRef(null);
		const panelRef = useRef(null);
		const groups = props.catalog ?? [];
		const group = groups.find((g) => g.id === props.value.provider);
		const picked = group?.models.find((m) => m.id === props.value.model);
		const isFollow = props.value.provider === "";
		const triggerLabel = isFollow ? t("modelFollow") : picked?.name ?? props.value.model;
		const triggerSub = isFollow ? "" : group?.name ?? props.value.provider + t("modelUnknown");
		const q$1 = query.trim().toLowerCase();
		const hit = (text) => {
			if (q$1 === "") return true;
			let i = 0;
			for (const ch of text.toLowerCase()) {
				if (ch === q$1[i]) i += 1;
				if (i >= q$1.length) return true;
			}
			return false;
		};
		const rows = [];
		if (q$1 === "") rows.push({
			kind: "follow",
			key: "__follow"
		});
		for (const g of groups) {
			const models = g.models.filter((m) => hit(m.name + " " + m.id));
			if (models.length === 0 && !(q$1 === "" && g.models.length === 0)) continue;
			rows.push({
				kind: "group",
				key: g.id,
				name: g.name
			});
			if (models.length === 0) {
				rows.push({
					kind: "none",
					key: g.id + "/__none"
				});
				continue;
			}
			for (const m of models) rows.push({
				kind: "model",
				key: g.id + "/" + m.id,
				provider: g.id,
				model: m
			});
		}
		const selectable = rows.map((r, i) => r.kind === "group" || r.kind === "none" ? -1 : i).filter((i) => i >= 0);
		const commit = (v) => {
			props.onChange(v);
			setOpen(false);
			setQuery("");
		};
		const pick$1 = (row) => {
			if (!row) return;
			if (row.kind === "follow") commit({
				provider: "",
				model: ""
			});
			else if (row.kind === "model") commit({
				provider: row.provider,
				model: row.model.id
			});
		};
		const step = (dir) => {
			if (selectable.length === 0) return;
			const at = selectable.indexOf(active);
			const next = selectable[at < 0 ? 0 : (at + dir + selectable.length) % selectable.length];
			setActive(next);
			panelRef.current?.querySelector("[data-row=\"" + next + "\"]")?.scrollIntoView({ block: "nearest" });
		};
		useEffect(() => {
			if (!open) return;
			const el = rootRef.current;
			const place = () => {
				if (!el) return;
				const r = el.getBoundingClientRect();
				const below = window.innerHeight - r.bottom - 12;
				const above = r.top - 12;
				const width = Math.min(Math.max(r.width, 240), Math.max(200, Math.min(420, window.innerWidth - 16)));
				const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
				const up = below < 240 && above > below;
				setPos(up ? {
					left,
					bottom: window.innerHeight - r.top + 4,
					width,
					maxHeight: Math.min(360, above)
				} : {
					left,
					top: r.bottom + 4,
					width,
					maxHeight: Math.min(360, below)
				});
			};
			place();
			panelRef.current?.querySelector("input")?.focus();
			const onDown = (e) => {
				const target = e.target;
				if (target && (rootRef.current?.contains(target) === true || panelRef.current?.contains(target) === true)) return;
				setOpen(false);
			};
			const onKey = (e) => {
				if (e.key === "Escape") setOpen(false);
			};
			document.addEventListener("mousedown", onDown, true);
			document.addEventListener("keydown", onKey, true);
			window.addEventListener("scroll", place, true);
			window.addEventListener("resize", place);
			return () => {
				document.removeEventListener("mousedown", onDown, true);
				document.removeEventListener("keydown", onKey, true);
				window.removeEventListener("scroll", place, true);
				window.removeEventListener("resize", place);
			};
		}, [open]);
		const toggle = () => {
			if (props.disabled) return;
			if (!open) {
				setQuery("");
				const at = rows.findIndex((r) => r.kind === "model" && r.provider === props.value.provider && r.model.id === props.value.model);
				setActive(at >= 0 ? at : 0);
			}
			setOpen(!open);
		};
		const searchRow = h("input", {
			key: "search",
			type: "text",
			className: "dsh-whale-girl-mp__search",
			role: "searchbox",
			placeholder: t("modelSearch"),
			"aria-label": t("modelSearch"),
			value: query,
			disabled: props.disabled,
			onChange: (e) => {
				setQuery(e.target.value);
				setActive(selectable.length > 0 ? selectable[0] : 0);
			},
			onKeyDown: (e) => {
				if (e.key === "ArrowDown") {
					e.preventDefault();
					step(1);
				} else if (e.key === "ArrowUp") {
					e.preventDefault();
					step(-1);
				} else if (e.key === "Enter") {
					e.preventDefault();
					pick$1(rows[active]);
				}
			}
		});
		const rowNode = (row, index) => {
			if (row.kind === "group") return h("div", {
				key: row.key,
				className: "dsh-whale-girl-mp__group",
				children: row.name
			});
			if (row.kind === "none") return h("div", {
				key: row.key,
				className: "dsh-whale-girl-mp__status",
				children: t("modelNone")
			});
			const checked = row.kind === "follow" ? isFollow : props.value.provider === row.provider && props.value.model === row.model.id;
			return h("button", {
				key: row.key,
				type: "button",
				role: "menuitemradio",
				"aria-checked": checked,
				"data-row": index,
				className: "dsh-whale-girl-mp__item" + (index === active ? " is-active" : ""),
				disabled: props.disabled,
				onClick: () => pick$1(row),
				onMouseMove: () => setActive(index),
				children: [h("span", {
					key: "n",
					className: "dsh-whale-girl-mp__name",
					children: row.kind === "follow" ? t("modelFollow") : row.model.name
				}), h("span", {
					key: "c",
					className: "dsh-whale-girl-mp__check",
					children: checked ? "✓" : ""
				})]
			});
		};
		return h("div", {
			ref: rootRef,
			className: "dsh-whale-girl-mp",
			children: [h("button", {
				key: "trigger",
				type: "button",
				className: "dsh-whale-girl-mp__trigger",
				disabled: props.disabled,
				"aria-haspopup": "menu",
				"aria-expanded": open,
				"aria-label": t("modelTriggerAria").replace("{model}", triggerLabel),
				onClick: toggle,
				children: [
					h("span", {
						key: "l",
						className: "dsh-whale-girl-mp__label",
						children: triggerLabel
					}),
					triggerSub ? h("span", {
						key: "s",
						className: "dsh-whale-girl-mp__sub",
						children: triggerSub
					}) : null,
					h("span", {
						key: "c",
						className: "dsh-whale-girl-mp__chevron" + (open ? " is-open" : ""),
						children: "▾"
					})
				]
			}), open && pos ? h("div", {
				key: "panel",
				ref: panelRef,
				className: "dsh-whale-girl-mp__panel",
				role: "menu",
				"aria-label": props.label,
				style: {
					left: pos.left + "px",
					top: pos.top === void 0 ? void 0 : pos.top + "px",
					bottom: pos.bottom === void 0 ? void 0 : pos.bottom + "px",
					width: pos.width + "px",
					maxHeight: pos.maxHeight + "px"
				},
				children: [searchRow, props.catalog === null ? h("div", {
					key: "loading",
					className: "dsh-whale-girl-mp__status",
					children: props.failed ? t("modelCatalogFailed") : t("modelLoading")
				}) : rows.length === 0 ? h("div", {
					key: "empty",
					className: "dsh-whale-girl-mp__status",
					role: "status",
					children: groups.length === 0 ? t("modelNoModels") : t("modelEmpty")
				}) : h("div", {
					key: "list",
					className: "dsh-whale-girl-mp__list",
					role: "group",
					children: rows.map(rowNode)
				})]
			}) : null]
		});
	};
	const VoiceSettingsCard = (props) => {
		const { registerSave } = props;
		const [shortcut, setShortcut] = useState("");
		const [voice, setVoice] = useState("");
		const [micDeviceId, setMicDeviceId] = useState("");
		const [hideButton, setHideButton] = useState(false);
		const [previewState, setPreviewState] = useState("idle");
		const [previewMsg, setPreviewMsg] = useState("");
		const [mics, setMics] = useState([]);
		const [micError, setMicError] = useState("");
		const [status, setStatus] = useState("idle");
		const [errText, setErrText] = useState("");
		/**
		
		* 宿主侧全局热键的状态（GET /voice/hotkey）。
		
		* null = 还没读到；ok=false 时把 message 显示出来——「按了没反应」时这是唯一线索。
		
		*/
		const [hotkey, setHotkey] = useState(null);
		const statusLine = status === "saving" ? t("saving") : status === "saved" ? t("sightSaved") : status === "error" ? errText : "";
		useEffect(() => {
			let alive = true;
			(async () => {
				try {
					const res = await fetch("/dsh-whale-girl/voice/config", { cache: "no-store" });
					if (!res.ok || !alive) return;
					const data = await res.json();
					if (!alive) return;
					if (typeof data.shortcut === "string") setShortcut(data.shortcut);
					if (typeof data.voice === "string") setVoice(data.voice);
					if (typeof data.micDeviceId === "string") setMicDeviceId(data.micDeviceId);
					if (data.hideButton === "true") setHideButton(true);
				} catch {}
			})();
			(async () => {
				try {
					const res = await fetch("/dsh-whale-girl/voice/hotkey", { cache: "no-store" });
					if (!res.ok || !alive) return;
					setHotkey(await res.json());
				} catch {}
			})();
			return () => {
				alive = false;
			};
		}, []);
		/**
		
		* 枚举麦克风。
		
		*
		
		* 浏览器的坑：**没拿到麦克风权限之前**，`enumerateDevices()` 返回的 audioinput
		
		* 只有 deviceId、label 全是空串（隐私保护）。所以这里先请一次权限
		
		* （拿到就立刻停掉轨道，不录音），再枚举才有可读的设备名。
		
		*/
		const refreshMics = async () => {
			setMicError("");
			try {
				const devices = navigator.mediaDevices;
				if (devices === void 0) throw new Error("这个环境不支持麦克风");
				try {
					const granted = await devices.getUserMedia({
						audio: true,
						video: false
					});
					granted.getTracks().forEach((track) => track.stop());
				} catch {}
				const all = await devices.enumerateDevices();
				const inputs = all.filter((d) => d.kind === "audioinput").map((d, i) => ({
					id: d.deviceId,
					label: d.label || `麦克风 ${i + 1}`
				}));
				setMics(inputs);
				if (inputs.length === 0) setMicError("没有检测到麦克风");
			} catch (e) {
				setMicError(e instanceof Error ? e.message : String(e));
			}
		};
		useEffect(() => {
			refreshMics();
		}, []);
		const [testing, setTesting] = useState(false);
		const [level, setLevel] = useState(0);
		const [peak, setPeak] = useState(0);
		const [testState, setTestState] = useState("idle");
		const [testMsg, setTestMsg] = useState("");
		const testStopRef = useRef(void 0);
		useEffect(() => {
			return () => {
				testStopRef.current?.();
			};
		}, []);
		const startMicTest = async () => {
			if (testing) {
				testStopRef.current?.();
				return;
			}
			setTestState("running");
			setTestMsg("");
			setLevel(0);
			setPeak(0);
			setTesting(true);
			let stream;
			let context;
			let raf = 0;
			let stopped = false;
			const stop = () => {
				if (stopped) return;
				stopped = true;
				cancelAnimationFrame(raf);
				stream?.getTracks().forEach((track) => track.stop());
				context?.close().catch(() => {});
				testStopRef.current = void 0;
				setTesting(false);
				setLevel(0);
			};
			testStopRef.current = stop;
			try {
				const devices = navigator.mediaDevices;
				if (devices === void 0) throw new Error("这个环境不支持麦克风");
				stream = await devices.getUserMedia({
					audio: {
						echoCancellation: true,
						noiseSuppression: true,
						...micDeviceId === "" ? {} : { deviceId: { exact: micDeviceId } }
					},
					video: false
				});
				context = new AudioContext();
				const source = context.createMediaStreamSource(stream);
				const analyser = context.createAnalyser();
				analyser.fftSize = 2048;
				source.connect(analyser);
				const buffer = new Float32Array(analyser.fftSize);
				const startedAt = performance.now();
				let maxPeak = 0;
				const tick = () => {
					if (stopped) return;
					analyser.getFloatTimeDomainData(buffer);
					let sum = 0;
					for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
					const rms = Math.sqrt(sum / buffer.length);
					const shown = Math.min(1, Math.sqrt(rms) * 2.2);
					maxPeak = Math.max(maxPeak, shown);
					setLevel(shown);
					setPeak(maxPeak);
					if (performance.now() - startedAt < 3e3) {
						raf = requestAnimationFrame(tick);
						return;
					}
					stop();
					if (maxPeak >= .06) {
						setTestState("loud");
						setTestMsg(t("voiceMicTestOk"));
					} else {
						setTestState("quiet");
						setTestMsg(t("voiceMicTestQuiet"));
					}
				};
				raf = requestAnimationFrame(tick);
			} catch (e) {
				stop();
				setTestState("error");
				const name = e instanceof DOMException ? e.name : "";
				setTestMsg(name === "NotAllowedError" ? t("voiceMicTestDenied") : name === "OverconstrainedError" ? t("voiceMicTestNotFound") : e instanceof Error ? e.message : String(e));
			}
		};
		/**
		
		* 试听：合成一句固定的话并真的播一遍。
		
		*
		
		* 为什么需要：主人遇到「有文字没声音」，可能是**系统输出设备**选错了
		
		* （这台机器上有 Voicemeeter / VR / USB 等十几个输出端点）。
		
		* 这个按钮把「合成是否成功」与「声音是否到你耳朵」分开验证：
		
		* 拿到音频并播放了、但你还是没听到 → 问题在系统声音，不在插件。
		
		*/
		const previewVoice = async () => {
			setPreviewState("loading");
			setPreviewMsg("");
			try {
				const sample = "主人，我是鲸鱼娘，能听到我吗？";
				const res = await fetch("/dsh-whale-girl/voice/tts", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						text: sample,
						voice: voice === "" ? void 0 : voice
					})
				});
				if (!res.ok) {
					setPreviewState("error");
					setPreviewMsg(`合成失败（HTTP ${res.status}）`);
					return;
				}
				const bytes = await res.arrayBuffer();
				if (bytes.byteLength === 0) {
					setPreviewState("error");
					setPreviewMsg("合成返回空音频");
					return;
				}
				const url = URL.createObjectURL(new Blob([bytes], { type: res.headers.get("content-type") ?? "audio/mpeg" }));
				const player = new Audio(url);
				player.addEventListener("ended", () => URL.revokeObjectURL(url));
				await player.play();
				const seconds = Number.isFinite(player.duration) ? player.duration.toFixed(1) : "?";
				setPreviewState("played");
				setPreviewMsg(`${t("voicePreviewPlayed")}（${seconds}s，${bytes.byteLength} 字节）`);
			} catch (e) {
				setPreviewState("error");
				setPreviewMsg(e instanceof Error ? e.message : String(e));
			}
		};
		/**
		
		* 保存语音设置。
		
		*
		
		* 返回值是**错误信息**（null = 成功）：置顶的「保存全部」要靠它汇总失败原因。
		
		* 卡片自己不渲染保存按钮了——全页只有一个保存入口，避免四处分叉。
		
		*/
		const save = async () => {
			setStatus("saving");
			setErrText("");
			try {
				const res = await fetch("/dsh-whale-girl/voice/config", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						shortcut,
						voice,
						micDeviceId,
						hideButton: hideButton ? "true" : "false"
					})
				});
				const data = await res.json();
				if (data.hotkey !== void 0) setHotkey(data.hotkey);
				if (!res.ok || data.ok !== true) {
					const message = data.message ?? `HTTP ${res.status}`;
					setStatus("error");
					setErrText(message);
					return message;
				}
				window.dispatchEvent(new Event(VOICE_CONFIG_EVENT));
				setStatus("saved");
				return null;
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				setStatus("error");
				setErrText(message);
				return message;
			}
		};
		useEffect(() => {
			registerSave("voice", save);
			return () => registerSave("voice", null);
		});
		return h("div", {
			className: "dsh-whale-girl-cfg__card",
			children: [
				cardHead(t("voiceTitle"), t("voiceHint")),
				statusLine === "" ? null : h("p", {
					className: "dsh-whale-girl-cfg__note",
					children: statusLine
				}),
				field(t("voiceMicLabel"), h("div", {
					style: {
						display: "flex",
						gap: "8px",
						alignItems: "center"
					},
					children: [h("select", {
						className: inputClass,
						value: micDeviceId,
						style: {
							flex: "1 1 auto",
							minWidth: "0"
						},
						onChange: (e) => {
							setMicDeviceId(e.target.value);
							setStatus("idle");
						},
						children: [h("option", {
							key: "",
							value: "",
							children: t("voiceMicDefault")
						}), ...mics.map((m) => h("option", {
							key: m.id,
							value: m.id,
							children: m.label
						}))]
					}), h("button", {
						type: "button",
						className: "dsh-whale-girl-cfg__btn",
						onClick: () => void refreshMics(),
						children: t("voiceMicRefresh")
					})]
				}), micError !== "" ? `${t("voiceMicHint")}（${micError}）` : mics.length > 1 ? `${t("voiceMicHint")}（检测到 ${mics.length} 个）` : t("voiceMicHint"), true),
				h("div", {
					className: "dsh-whale-girl-cfg__row",
					style: {
						display: "flex",
						gap: "10px",
						alignItems: "center",
						flexWrap: "wrap"
					},
					children: [
						h("button", {
							type: "button",
							className: "dsh-whale-girl-cfg__btn",
							onClick: () => void startMicTest(),
							children: testing ? t("voiceMicTestStop") : t("voiceMicTest")
						}),
						h("div", {
							style: {
								position: "relative",
								flex: "1 1 160px",
								minWidth: "120px",
								height: "10px",
								borderRadius: "5px",
								background: "rgba(255,255,255,.12)",
								overflow: "hidden"
							},
							children: [h("div", {
								key: "fill",
								style: {
									position: "absolute",
									left: "0",
									top: "0",
									bottom: "0",
									width: `${Math.round(level * 100)}%`,
									background: peak >= .06 ? "rgba(96,220,140,.95)" : "rgba(96,140,255,.9)",
									transition: "width .06s linear"
								}
							}), h("div", {
								key: "peak",
								style: {
									position: "absolute",
									top: "0",
									bottom: "0",
									left: `${Math.round(Math.min(99, peak * 100))}%`,
									width: "2px",
									background: "rgba(255,255,255,.85)"
								}
							})]
						}),
						testMsg !== "" ? h("span", {
							style: {
								fontSize: "12px",
								color: testState === "loud" ? "var(--dsw-alias-state-success-primary, #2e9e4f)" : testState === "error" ? "var(--dsw-alias-state-error-primary)" : "var(--dsw-alias-label-secondary)"
							},
							children: testMsg
						}) : null
					]
				}),
				h("p", {
					className: "dsh-whale-girl-cfg__note",
					children: t("voiceMicTestHint")
				}),
				h("div", {
					className: "dsh-whale-girl-cfg__row",
					style: {
						display: "flex",
						gap: "10px",
						alignItems: "center",
						flexWrap: "wrap"
					},
					children: [h("button", {
						type: "button",
						className: "dsh-whale-girl-cfg__btn",
						disabled: previewState === "loading",
						onClick: () => void previewVoice(),
						children: previewState === "loading" ? t("voicePreviewLoading") : t("voicePreview")
					}), previewMsg !== "" ? h("span", {
						style: {
							fontSize: "12px",
							color: previewState === "error" ? "var(--dsw-alias-state-error-primary)" : "var(--dsw-alias-label-secondary)"
						},
						children: previewMsg
					}) : null]
				}),
				h("p", {
					className: "dsh-whale-girl-cfg__note",
					children: t("voicePreviewHint")
				}),
				h("div", {
					className: "dsh-whale-girl-cfg__row",
					style: {
						display: "flex",
						gap: "10px",
						alignItems: "center",
						flexWrap: "wrap"
					},
					children: [h("label", {
						style: {
							display: "flex",
							gap: "8px",
							alignItems: "center",
							cursor: "pointer"
						},
						children: [h("input", {
							type: "checkbox",
							checked: hideButton,
							onChange: (e) => {
								setHideButton(e.target.checked);
								setStatus("idle");
							}
						}), h("span", { children: t("voiceHideButton") })]
					})]
				}),
				h("p", {
					className: "dsh-whale-girl-cfg__note",
					children: t("voiceHideButtonHint")
				}),
				h("div", {
					className: "dsh-whale-girl-cfg__grid2",
					children: [field(t("voiceShortcutLabel"), h("input", {
						type: "text",
						className: inputClass,
						value: shortcut,
						placeholder: "Alt+V",
						onChange: (e) => {
							setShortcut(e.target.value);
							setStatus("idle");
						}
					}), t("voiceShortcutHint")), field(t("voiceNameLabel"), h("input", {
						type: "text",
						className: inputClass,
						value: voice,
						placeholder: "zh-CN-XiaoyiNeural",
						onChange: (e) => {
							setVoice(e.target.value);
							setStatus("idle");
						}
					}), t("voiceNameHint"), true)]
				}),
				hotkey === null ? null : h("p", {
					className: "dsh-whale-girl-cfg__note",
					style: hotkey.ok === true ? void 0 : { color: "#ff9a9a" },
					children: hotkey.ok === true ? t("voiceHotkeyRunning").replace("{{shortcut}}", hotkey.shortcut ?? "") : t("voiceHotkeyFailed").replace("{{message}}", hotkey.message ?? "")
				})
			]
		});
	};
	/**
	
	* 人设与对话记忆卡。
	
	*
	
	* 两个需求来自主人：
	
	*   1. 人设要能自己写（不想为了改一句提示词去改 main-config.jsonc）；
	
	*   2. 想把手机端的聊天记录迁移过来——所以有导入/导出，导出就是可移植的 JSON。
	
	*
	
	* 这一卡的按钮各自即时保存，不参与页面底部的「保存全部」（与语音卡同一约定）。
	
	*/
	const MemoryPersonaCard = () => {
		const [prompt, setPrompt] = useState("");
		const [personaSource, setPersonaSource] = useState("");
		const [personaStatus, setPersonaStatus] = useState("");
		const [memCount, setMemCount] = useState(null);
		const [importText, setImportText] = useState("");
		const [memStatus, setMemStatus] = useState("");
		const [busy, setBusy] = useState(false);
		const loadPersona = useCallback(async () => {
			try {
				const res = await fetch("/dsh-whale-girl/persona", { cache: "no-store" });
				if (!res.ok) return;
				const data = await res.json();
				setPrompt(typeof data.prompt === "string" ? data.prompt : "");
				setPersonaSource(typeof data.source === "string" ? data.source : "");
			} catch {}
		}, []);
		const loadMemory = useCallback(async () => {
			try {
				const res = await fetch("/dsh-whale-girl/memory", { cache: "no-store" });
				if (!res.ok) return;
				const data = await res.json();
				setMemCount(typeof data.count === "number" ? data.count : 0);
			} catch {}
		}, []);
		useEffect(() => {
			loadPersona();
			loadMemory();
		}, [loadPersona, loadMemory]);
		const savePersona = async () => {
			setBusy(true);
			setPersonaStatus("");
			try {
				const res = await fetch("/dsh-whale-girl/persona", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ prompt })
				});
				const data = await res.json();
				if (!res.ok || data.ok !== true) {
					setPersonaStatus(data.message ?? "HTTP " + res.status);
					return;
				}
				setPersonaSource(data.source ?? "");
				setPersonaStatus(t("personaSaved"));
			} catch (e) {
				setPersonaStatus(e instanceof Error ? e.message : String(e));
			} finally {
				setBusy(false);
			}
		};
		const importMemory = async () => {
			if (importText.trim() === "") {
				setMemStatus(t("memoryEmpty"));
				return;
			}
			setBusy(true);
			setMemStatus("");
			try {
				const res = await fetch("/dsh-whale-girl/memory/import", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ payload: importText })
				});
				const data = await res.json();
				if (!res.ok || data.ok !== true) {
					setMemStatus(data.message ?? "HTTP " + res.status);
					return;
				}
				setMemStatus(t("memoryImported").replace("{{added}}", String(data.added ?? 0)).replace("{{total}}", String(data.total ?? 0)));
				setImportText("");
				await loadMemory();
			} catch (e) {
				setMemStatus(e instanceof Error ? e.message : String(e));
			} finally {
				setBusy(false);
			}
		};
		const exportMemory = async () => {
			try {
				const res = await fetch("/dsh-whale-girl/memory/export", { cache: "no-store" });
				if (!res.ok) return;
				const data = await res.json();
				const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
				const url = URL.createObjectURL(blob);
				const a = document.createElement("a");
				a.href = url;
				a.download = "whale-girl-memory.json";
				a.click();
				URL.revokeObjectURL(url);
			} catch {
				setMemStatus(t("memoryExportFailed"));
			}
		};
		const clearMemory = async () => {
			if (!window.confirm(t("memoryClearConfirm"))) return;
			setBusy(true);
			try {
				const res = await fetch("/dsh-whale-girl/memory/clear", { method: "POST" });
				if (res.ok) {
					setMemStatus(t("memoryCleared"));
					await loadMemory();
				}
			} catch (e) {
				setMemStatus(e instanceof Error ? e.message : String(e));
			} finally {
				setBusy(false);
			}
		};
		return h("div", {
			className: "dsh-whale-girl-cfg__card",
			children: [
				cardHead(t("personaTitle"), t("personaHint")),
				h("textarea", {
					className: inputClass,
					rows: 7,
					value: prompt,
					placeholder: t("personaPlaceholder"),
					onChange: (e) => {
						setPrompt(e.target.value);
						setPersonaStatus("");
					}
				}),
				h("p", {
					className: "dsh-whale-girl-cfg__note",
					children: personaSource === "persona.json" ? t("personaUsingFile") : t("personaUsingConfig")
				}),
				h("div", {
					className: "dsh-whale-girl-cfg__actions",
					children: [h("button", {
						type: "button",
						className: "dsh-whale-girl-cfg__btn",
						disabled: busy,
						onClick: () => void savePersona(),
						children: t("personaSave")
					}), personaStatus === "" ? null : h("span", {
						className: "dsh-whale-girl-cfg__note",
						children: personaStatus
					})]
				}),
				cardHead(t("memoryTitle"), t("memoryHint").replace("{{count}}", String(memCount ?? "…"))),
				h("textarea", {
					className: inputClass,
					rows: 6,
					value: importText,
					placeholder: t("memoryPlaceholder"),
					onChange: (e) => {
						setImportText(e.target.value);
						setMemStatus("");
					}
				}),
				h("div", {
					className: "dsh-whale-girl-cfg__actions",
					children: [
						h("input", {
							type: "file",
							accept: ".json,.txt,application/json,text/plain",
							onChange: (e) => {
								const file = e.target.files?.[0];
								if (file === void 0) return;
								file.text().then((text) => {
									setImportText(text);
									setMemStatus("");
								});
							}
						}),
						h("button", {
							type: "button",
							className: "dsh-whale-girl-cfg__btn",
							disabled: busy,
							onClick: () => void importMemory(),
							children: t("memoryImport")
						}),
						h("button", {
							type: "button",
							className: "dsh-whale-girl-cfg__btn",
							disabled: busy,
							onClick: () => void exportMemory(),
							children: t("memoryExport")
						}),
						h("button", {
							type: "button",
							className: "dsh-whale-girl-cfg__btn",
							disabled: busy,
							onClick: () => void clearMemory(),
							children: t("memoryClear")
						}),
						memStatus === "" ? null : h("span", {
							className: "dsh-whale-girl-cfg__note",
							children: memStatus
						})
					]
				})
			]
		});
	};
	/**
	
	* 对话记录卡：给主人**翻阅**用的完整来往（含动作/神态），与记忆分开。
	
	*
	
	* 为什么单独一份：记忆是喂给模型的上下文（只存台词），动作版本存进去会被模仿；
	
	* 而「对话记录」只显示、不回流，所以可以保留完整的表演细节。
	
	*/
	const ChatLogCard = () => {
		const [entries, setEntries] = useState([]);
		const [hasMore, setHasMore] = useState(false);
		const [loading, setLoading] = useState(false);
		const [status, setStatus] = useState("");
		const load = useCallback(async (before) => {
			setLoading(true);
			setStatus("");
			try {
				const q$1 = new URLSearchParams({ limit: "50" });
				if (before !== void 0) q$1.set("before", String(before));
				const res = await fetch("/dsh-whale-girl/chatlog?" + q$1.toString(), { cache: "no-store" });
				const data = await res.json();
				if (!res.ok || data.ok !== true) {
					setStatus("HTTP " + res.status);
					return;
				}
				setEntries((prev) => before === void 0 ? data.entries ?? [] : [...prev, ...data.entries ?? []]);
				setHasMore(data.hasMore === true);
			} catch (e) {
				setStatus(e instanceof Error ? e.message : String(e));
			} finally {
				setLoading(false);
			}
		}, []);
		useEffect(() => {
			load();
		}, [load]);
		const clear = async () => {
			if (!window.confirm(t("chatlogClearConfirm"))) return;
			try {
				const res = await fetch("/dsh-whale-girl/chatlog/clear", { method: "POST" });
				if (res.ok) {
					setEntries([]);
					setHasMore(false);
					setStatus(t("chatlogCleared"));
				}
			} catch (e) {
				setStatus(e instanceof Error ? e.message : String(e));
			}
		};
		const exportLog = async () => {
			try {
				const res = await fetch("/dsh-whale-girl/chatlog/export", { cache: "no-store" });
				if (!res.ok) return;
				const data = await res.json();
				const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
				const url = URL.createObjectURL(blob);
				const a = document.createElement("a");
				a.href = url;
				a.download = "whale-girl-chatlog.json";
				a.click();
				URL.revokeObjectURL(url);
			} catch {
				setStatus(t("chatlogLoadFailed"));
			}
		};
		const fmt = (ts) => {
			const d = new Date(ts);
			const p = (n) => String(n).padStart(2, "0");
			return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
		};
		return h("div", {
			className: "dsh-whale-girl-cfg__card",
			children: [
				cardHead(t("chatlogTitle"), t("chatlogHint")),
				h("div", {
					className: "dsh-whale-girl-cfg__actions",
					children: [
						h("button", {
							type: "button",
							className: "dsh-whale-girl-cfg__btn",
							disabled: loading,
							onClick: () => void load(),
							children: t("chatlogRefresh")
						}),
						h("button", {
							type: "button",
							className: "dsh-whale-girl-cfg__btn",
							disabled: loading,
							onClick: () => void exportLog(),
							children: t("chatlogExport")
						}),
						h("button", {
							type: "button",
							className: "dsh-whale-girl-cfg__btn",
							disabled: loading,
							onClick: () => void clear(),
							children: t("chatlogClear")
						}),
						status === "" ? null : h("span", {
							className: "dsh-whale-girl-cfg__note",
							children: status
						})
					]
				}),
				entries.length === 0 ? h("p", {
					className: "dsh-whale-girl-cfg__note",
					children: loading ? t("chatlogLoading") : t("chatlogEmpty")
				}) : h("div", {
					style: { marginTop: "10px" },
					children: entries.map((entry) => h("div", {
						key: String(entry.ts) + entry.user.slice(0, 8),
						style: {
							padding: "10px 0",
							borderBottom: "1px solid var(--dsw-alias-border-l2)",
							fontSize: "13px",
							lineHeight: "20px"
						},
						children: [
							h("div", {
								className: "dsh-whale-girl-cfg__note",
								children: fmt(entry.ts)
							}),
							h("div", { children: "主人：" + entry.user }),
							h("div", {
								style: { marginTop: "4px" },
								children: "鲸鱼娘：" + entry.speech
							}),
							entry.action === "" ? null : h("div", {
								className: "dsh-whale-girl-cfg__note",
								style: { marginTop: "4px" },
								children: "【动作】" + entry.action
							})
						]
					}))
				}),
				hasMore ? h("div", {
					className: "dsh-whale-girl-cfg__actions",
					children: h("button", {
						type: "button",
						className: "dsh-whale-girl-cfg__btn",
						disabled: loading,
						onClick: () => {
							const last = entries[entries.length - 1];
							if (last !== void 0) load(last.ts);
						},
						children: t("chatlogLoadMore")
					})
				}) : null
			]
		});
	};
	/**
	
	* 主动识屏设置卡（看屏幕搭话）。
	
	*
	
	* 三条口径直接写进界面，避免主人对一个「会偷看屏幕的插件」产生疑虑：
	
	*   1. 默认关，开了才截图
	
	*   2. 图片**只进内存**发出去，不写任何文件（走官方 API 的 base64 图片字段）
	
	*   3. 留一份快照给你核对「她到底看了什么」，可看可删、张数可调
	
	*/
	const SightSettingsCard = (props) => {
		const { registerSave } = props;
		const [enabled, setEnabled] = useState(false);
		const [intervalSec, setIntervalSec] = useState(60);
		const [keepSnapshots, setKeepSnapshots] = useState(20);
		const [speak, setSpeak] = useState(false);
		const [mode, setMode] = useState("companion");
		const [jitterMin, setJitterMin] = useState(.6);
		const [jitterMax, setJitterMax] = useState(1.6);
		const [memoryShared, setMemoryShared] = useState(true);
		/** 语音对话里主动识屏：off / auto / always */
		const [voiceVision, setVoiceVision] = useState("auto");
		/** 连拍帧数：1 = 最省，3~5 能看出画面变化 */
		const [voiceFrames, setVoiceFrames] = useState(3);
		/** 连拍帧间隔（毫秒） */
		const [voiceFrameGapMs, setVoiceFrameGapMs] = useState(700);
		const [snapshots, setSnapshots] = useState({
			count: 0,
			bytes: 0
		});
		const [dir, setDir] = useState("");
		/** 实际生效的识图模型（服务商/模型）。null = 还没解析出来 */
		const [visionResolved, setVisionResolved] = useState(null);
		const [status, setStatus] = useState("idle");
		const [errText, setErrText] = useState("");
		const statusLine = status === "saving" ? t("saving") : status === "saved" ? t("sightSaved") : status === "error" ? errText : "";
		const [runState, setRunState] = useState("idle");
		const [runMsg, setRunMsg] = useState("");
		/** 最近一次快照的文件名清单（点开可看原图） */
		const [files, setFiles] = useState([]);
		const reload = useCallback(async () => {
			try {
				const res = await fetch("/dsh-whale-girl/sight/config");
				if (!res.ok) return;
				const data = await res.json();
				if (data.config) {
					setEnabled(data.config.enabled === true);
					setIntervalSec(data.config.intervalSec ?? 60);
					setKeepSnapshots(data.config.keepSnapshots ?? 20);
					setSpeak(data.config.speak === true);
					if (data.config.mode === "play" || data.config.mode === "watch" || data.config.mode === "companion") setMode(data.config.mode);
					if (typeof data.config.jitterMin === "number") setJitterMin(data.config.jitterMin);
					if (typeof data.config.jitterMax === "number") setJitterMax(data.config.jitterMax);
					setMemoryShared(data.config.memoryShared !== false);
					if (data.config.voiceVision === "off" || data.config.voiceVision === "always" || data.config.voiceVision === "auto") setVoiceVision(data.config.voiceVision);
					if (typeof data.config.voiceFrames === "number") setVoiceFrames(data.config.voiceFrames);
					if (typeof data.config.voiceFrameGapMs === "number") setVoiceFrameGapMs(data.config.voiceFrameGapMs);
				}
				setSnapshots({
					count: data.snapshots?.count ?? 0,
					bytes: data.snapshots?.bytes ?? 0
				});
				setDir(data.dir ?? "");
				setVisionResolved(data.visionModelResolved && typeof data.visionModelResolved.provider === "string" && typeof data.visionModelResolved.model === "string" ? {
					provider: data.visionModelResolved.provider,
					model: data.visionModelResolved.model
				} : null);
				const listRes = await fetch("/dsh-whale-girl/sight/snapshots");
				if (listRes.ok) {
					const listData = await listRes.json();
					setFiles(Array.isArray(listData.files) ? listData.files : []);
				}
			} catch {}
		}, []);
		useEffect(() => {
			reload();
		}, [reload]);
		/** 保存识屏设置（返回错误信息，null = 成功；由顶部统一按钮调用） */
		const save = async () => {
			setStatus("saving");
			setErrText("");
			try {
				const res = await fetch("/dsh-whale-girl/sight/config", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						enabled,
						intervalSec,
						keepSnapshots,
						speak,
						mode,
						jitterMin,
						jitterMax,
						memoryShared,
						voiceVision,
						voiceFrames,
						voiceFrameGapMs
					})
				});
				const data = await res.json();
				if (!res.ok || data.ok !== true) {
					const message = data.message ?? `HTTP ${res.status}`;
					setStatus("error");
					setErrText(message);
					return message;
				}
				setStatus("saved");
				await reload();
				return null;
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				setStatus("error");
				setErrText(message);
				return message;
			}
		};
		useEffect(() => {
			registerSave("sight", save);
			return () => registerSave("sight", null);
		});
		const runOnce = async () => {
			setRunState("running");
			setRunMsg("");
			try {
				const res = await fetch("/dsh-whale-girl/sight/run", { method: "POST" });
				const data = await res.json();
				if (data.kind === "spoke") setRunMsg(`${t("sightRunSpoke")}：${data.text ?? ""}`);
				else if (data.kind === "skipped") setRunMsg(t("sightRunSkipped") + `（${data.reason ?? ""}）`);
				else setRunMsg(`${t("sightRunFailed")}：${data.message ?? data.reason ?? ""}`);
				setRunState("done");
				await reload();
			} catch (e) {
				setRunState("done");
				setRunMsg(e instanceof Error ? e.message : String(e));
			}
		};
		return h("div", {
			className: "dsh-whale-girl-cfg__card",
			children: [
				h("h3", {
					className: "dsh-whale-girl-cfg__title",
					children: t("sightTitle")
				}),
				statusLine === "" ? null : h("p", {
					className: "dsh-whale-girl-cfg__note",
					children: statusLine
				}),
				h("p", {
					className: "dsh-whale-girl-cfg__note",
					children: t("sightHint")
				}),
				h("div", {
					style: {
						display: "flex",
						gap: "10px",
						alignItems: "center",
						flexWrap: "wrap"
					},
					children: [h("label", {
						style: {
							display: "flex",
							gap: "8px",
							alignItems: "center",
							cursor: "pointer"
						},
						children: [h("input", {
							type: "checkbox",
							checked: enabled,
							onChange: (e) => {
								setEnabled(e.target.checked);
								setStatus("idle");
							}
						}), h("span", { children: t("sightEnabled") })]
					})]
				}),
				h("p", {
					className: "dsh-whale-girl-cfg__note",
					children: t("sightEnabledHint")
				}),
				h("p", {
					className: "dsh-whale-girl-cfg__note",
					style: { fontFamily: MONO },
					children: t("sightVisionModelLabel") + "：" + (visionResolved === null ? "—" : `${visionResolved.provider}/${visionResolved.model}`)
				}),
				h("div", {
					className: "dsh-whale-girl-cfg__grid2",
					children: [field(t("sightIntervalLabel"), h("input", {
						type: "number",
						className: inputClass,
						min: 15,
						max: 3600,
						value: intervalSec,
						onChange: (e) => {
							setIntervalSec(Number(e.target.value) || 60);
							setStatus("idle");
						}
					}), t("sightIntervalHint")), field(t("sightKeepLabel"), h("input", {
						type: "number",
						className: inputClass,
						min: 0,
						max: 200,
						value: keepSnapshots,
						onChange: (e) => {
							setKeepSnapshots(Number(e.target.value) || 0);
							setStatus("idle");
						}
					}), t("sightKeepHint"))]
				}),
				h("div", {
					className: "dsh-whale-girl-cfg__row",
					style: {
						display: "flex",
						gap: "10px",
						alignItems: "center",
						flexWrap: "wrap"
					},
					children: [h("span", { children: t("sightModeLabel") }), h("select", {
						className: inputClass,
						value: mode,
						onChange: (e) => {
							const v = e.target.value;
							if (v === "companion" || v === "play" || v === "watch") setMode(v);
							setStatus("idle");
						},
						children: [
							h("option", {
								key: "companion",
								value: "companion",
								children: t("sightModeCompanion")
							}),
							h("option", {
								key: "play",
								value: "play",
								children: t("sightModePlay")
							}),
							h("option", {
								key: "watch",
								value: "watch",
								children: t("sightModeWatch")
							})
						]
					})]
				}),
				h("p", {
					className: "dsh-whale-girl-cfg__note",
					children: t("sightModeHint")
				}),
				h("div", {
					className: "dsh-whale-girl-cfg__grid2",
					children: [field(t("sightJitterMinLabel"), h("input", {
						type: "number",
						className: inputClass,
						min: .2,
						max: 3,
						step: .1,
						value: jitterMin,
						onChange: (e) => {
							setJitterMin(Number(e.target.value) || .6);
							setStatus("idle");
						}
					}), t("sightJitterHint")), field(t("sightJitterMaxLabel"), h("input", {
						type: "number",
						className: inputClass,
						min: .2,
						max: 5,
						step: .1,
						value: jitterMax,
						onChange: (e) => {
							setJitterMax(Number(e.target.value) || 1.6);
							setStatus("idle");
						}
					}), t("sightJitterHint"))]
				}),
				h("div", {
					style: {
						display: "flex",
						gap: "10px",
						alignItems: "center",
						flexWrap: "wrap"
					},
					children: [h("label", {
						style: {
							display: "flex",
							gap: "8px",
							alignItems: "center",
							cursor: "pointer"
						},
						children: [h("input", {
							type: "checkbox",
							checked: memoryShared,
							onChange: (e) => {
								setMemoryShared(e.target.checked);
								setStatus("idle");
							}
						}), h("span", { children: t("sightMemoryShared") })]
					})]
				}),
				h("p", {
					className: "dsh-whale-girl-cfg__note",
					children: t("sightMemoryHint")
				}),
				h("div", {
					style: {
						display: "flex",
						gap: "10px",
						alignItems: "center",
						flexWrap: "wrap"
					},
					children: [h("label", {
						style: {
							display: "flex",
							gap: "8px",
							alignItems: "center",
							cursor: "pointer"
						},
						children: [h("input", {
							type: "checkbox",
							checked: speak,
							onChange: (e) => {
								setSpeak(e.target.checked);
								setStatus("idle");
							}
						}), h("span", { children: t("sightSpeak") })]
					})]
				}),
				h("p", {
					className: "dsh-whale-girl-cfg__note",
					children: t("sightSpeakHint")
				}),
				h("div", {
					className: "dsh-whale-girl-cfg__grid2",
					children: [field(t("voiceVisionLabel"), h("select", {
						className: inputClass,
						value: voiceVision,
						onChange: (e) => {
							const v = e.target.value;
							if (v === "off" || v === "auto" || v === "always") setVoiceVision(v);
							setStatus("idle");
						},
						children: [
							h("option", {
								key: "off",
								value: "off",
								children: t("voiceVisionOff")
							}),
							h("option", {
								key: "auto",
								value: "auto",
								children: t("voiceVisionAuto")
							}),
							h("option", {
								key: "always",
								value: "always",
								children: t("voiceVisionAlways")
							})
						]
					}), t("voiceVisionHint")), field(t("voiceFramesLabel"), h("input", {
						type: "number",
						className: inputClass,
						min: 1,
						max: 5,
						value: voiceFrames,
						onChange: (e) => {
							setVoiceFrames(Number(e.target.value) || 1);
							setStatus("idle");
						}
					}), t("voiceFramesHint"))]
				}),
				field(t("voiceGapLabel"), h("input", {
					type: "number",
					className: inputClass,
					min: 200,
					max: 2e3,
					step: 100,
					value: voiceFrameGapMs,
					onChange: (e) => {
						setVoiceFrameGapMs(Number(e.target.value) || 700);
						setStatus("idle");
					}
				}), t("voiceGapHint")),
				h("div", {
					style: {
						display: "flex",
						gap: "10px",
						alignItems: "center",
						flexWrap: "wrap"
					},
					children: [h("button", {
						type: "button",
						className: "dsh-whale-girl-cfg__btn",
						disabled: runState === "running",
						onClick: () => void runOnce(),
						children: runState === "running" ? t("sightRunning") : t("sightRunNow")
					}), runMsg === "" ? null : h("span", {
						className: "dsh-whale-girl-cfg__note",
						children: runMsg
					})]
				}),
				h("p", {
					className: "dsh-whale-girl-cfg__note",
					children: `${t("sightSnapshots")}：${snapshots.count} 张 / ${Math.round(snapshots.bytes / 1024)} KB${dir === "" ? "" : `　（${dir}）`}`
				}),
				files.length === 0 ? null : h("div", {
					style: {
						display: "flex",
						gap: "8px",
						flexWrap: "wrap",
						marginTop: "6px"
					},
					children: files.slice(-6).map((name) => h("a", {
						key: name,
						href: `/dsh-whale-girl/sight/snapshot/${encodeURIComponent(name)}`,
						target: "_blank",
						rel: "noreferrer",
						title: name,
						children: h("img", {
							src: `/dsh-whale-girl/sight/snapshot/${encodeURIComponent(name)}`,
							alt: name,
							style: {
								width: "120px",
								height: "75px",
								objectFit: "cover",
								borderRadius: "6px",
								border: "1px solid rgba(255,255,255,.18)",
								display: "block"
							}
						})
					}))
				})
			]
		});
	};
	/**
	
	* 代打设置卡（看屏幕 → 想一步 → 动手）。
	
	*
	
	* 安全口径写在界面上，不藏着：
	
	*   1. **默认空跑**：只打印「打算做什么」，不真的按键点鼠标
	
	*   2. **急停键**必须选，且随时可按（F8~F12 / Esc / Pause / ScrollLock）
	
	*   3. **只在你指定的窗口里动手**（白名单，前台标题不匹配一律拒绝）
	
	*   4. 你一动鼠标键盘，她立刻撒手
	
	*/
	/**
	
	* 应用名单：她能打开哪些程序、每个名字对应什么可执行文件。
	
	*
	
	* 主人要求「一口气给所有常见应用做一份识别名单，并且支持查阅和增减修改」，
	
	* 所以这里直接给一张可编辑的表：每行 `名字=可执行名`。
	
	*/
	const AppsCard = () => {
		const [text, setText] = useState("");
		const [msg, setMsg] = useState("");
		const [busy, setBusy] = useState(false);
		const load = useCallback(async () => {
			try {
				const res = await fetch("/dsh-whale-girl/apps/aliases");
				if (!res.ok) return;
				const data = await res.json();
				setText(Object.entries(data.aliases ?? {}).map(([k, v]) => `${k}=${v}`).join("\n"));
			} catch {}
		}, []);
		useEffect(() => {
			load();
		}, [load]);
		const save = async () => {
			const map = {};
			for (const line of text.split("\n")) {
				const i = line.indexOf("=");
				if (i <= 0) continue;
				const k = line.slice(0, i).trim();
				const v = line.slice(i + 1).trim();
				if (k !== "" && v !== "") map[k] = v;
			}
			setBusy(true);
			setMsg("");
			try {
				const res = await fetch("/dsh-whale-girl/apps/aliases", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(map)
				});
				const d = await res.json();
				setMsg(d.ok === true ? t("appsSaved") : d.message ?? t("appsFailed"));
			} catch (e) {
				setMsg(e instanceof Error ? e.message : t("appsFailed"));
			} finally {
				setBusy(false);
			}
		};
		return h("div", {
			className: "dsh-whale-girl-cfg__card",
			children: [
				h("h3", {
					key: "t",
					className: "dsh-whale-girl-cfg__title",
					children: t("appsTitle")
				}),
				h("p", {
					key: "h",
					className: "dsh-whale-girl-cfg__note",
					children: t("appsHint")
				}),
				h("textarea", {
					key: "ta",
					className: inputClass,
					rows: 14,
					value: text,
					spellCheck: false,
					onChange: (e) => {
						setText(e.target.value);
						setMsg("");
					}
				}),
				h("div", {
					key: "a",
					className: "dsh-whale-girl-cfg__actions",
					children: [
						h("button", {
							key: "s",
							type: "button",
							disabled: busy,
							onClick: () => void save(),
							children: t("appsSave")
						}),
						h("button", {
							key: "r",
							type: "button",
							disabled: busy,
							onClick: () => void load(),
							children: t("appsReload")
						}),
						msg === "" ? null : h("span", {
							key: "m",
							className: "dsh-whale-girl-cfg__note",
							children: msg
						})
					]
				})
			]
		});
	};
	const AutoplaySettingsCard = (props) => {
		const { registerSave } = props;
		const [gameTitle, setGameTitle] = useState("");
		const [gameGenre, setGameGenre] = useState("custom");
		const [gameKeys, setGameKeys] = useState("");
		const [gameNotes, setGameNotes] = useState("");
		/** 本局记忆容量（空 = 用类型预设） */
		const [gameCap, setGameCap] = useState("");
		/** 各类型的预设容量（宿主给，用于在旁边提示） */
		const [genreCaps, setGenreCaps] = useState({});
		const [gameMsg, setGameMsg] = useState("");
		const [guideBusy, setGuideBusy] = useState(false);
		/** 本局进度文案 */
		const [sessionText, setSessionText] = useState("");
		/** 读回档案与本局进度 */
		const reloadGame = useCallback(async () => {
			try {
				const res = await fetch("/dsh-whale-girl/autoplay/games");
				if (res.ok) {
					const data = await res.json();
					if (data.genreCaps !== void 0) setGenreCaps(data.genreCaps);
					const first = data.games?.[0];
					if (first !== void 0) {
						setGameTitle(first.title ?? "");
						setGameGenre(first.genre ?? "custom");
						setGameKeys(Object.entries(first.keys ?? {}).map(([k, v]) => k + "=" + v).join("\n"));
						setGameNotes((first.notes ?? []).join("\n"));
						setGameCap(typeof first.memoryCap === "number" ? String(first.memoryCap) : "");
					}
				}
				const sres = await fetch("/dsh-whale-girl/autoplay/session");
				if (sres.ok) {
					const sdata = await sres.json();
					const s = sdata.session;
					setSessionText(s === null || s === void 0 ? t("sessionNone") : `${s.gameTitle ?? ""}：已记 ${s.steps ?? 0} / ${s.cap ?? 0} 步`);
				}
			} catch {}
		}, []);
		useEffect(() => {
			reloadGame();
		}, [reloadGame]);
		/** 保存档案（键位按「动作=键」每行一条） */
		const saveGame = async () => {
			const keys = {};
			for (const line of gameKeys.split("\n")) {
				const idx = line.indexOf("=");
				if (idx <= 0) continue;
				const action = line.slice(0, idx).trim();
				const key = line.slice(idx + 1).trim();
				if (action !== "" && key !== "") keys[action] = key;
			}
			setGameMsg("");
			try {
				const res = await fetch("/dsh-whale-girl/autoplay/games", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						title: gameTitle,
						genre: gameGenre,
						keys,
						notes: gameNotes.split("\n").map((s) => s.trim()).filter((s) => s !== ""),
						...gameCap.trim() === "" ? {} : { memoryCap: Number(gameCap) }
					})
				});
				const data = await res.json();
				setGameMsg(data.ok === true ? t("gameSaved") : data.message ?? `HTTP ${res.status}`);
			} catch (e) {
				setGameMsg(e instanceof Error ? e.message : String(e));
			}
		};
		/** 联网查攻略（走宿主 ctx.web，结果写进档案） */
		const lookupGuide = async () => {
			if (gameTitle.trim() === "") {
				setGameMsg(t("gameNeedName"));
				return;
			}
			setGuideBusy(true);
			setGameMsg("");
			try {
				const res = await fetch("/dsh-whale-girl/autoplay/guide", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ title: gameTitle.trim() })
				});
				const data = await res.json();
				setGameMsg(data.ok === true ? t("gameGuideDone") + "：" + (data.guide?.summary ?? "").slice(0, 80) : data.message ?? t("gameGuideFailed"));
			} catch (e) {
				setGameMsg(e instanceof Error ? e.message : String(e));
			} finally {
				setGuideBusy(false);
			}
		};
		/** 结束本局：压缩进共用记忆 */
		const endSession = async () => {
			try {
				const res = await fetch("/dsh-whale-girl/autoplay/end", { method: "POST" });
				const data = await res.json();
				setGameMsg(data.ended === null || data.ended === void 0 ? t("sessionNothing") : t("sessionEnded") + "：" + (data.ended.summary ?? ""));
				setPlaying(false);
				await reloadGame();
			} catch (e) {
				setGameMsg(e instanceof Error ? e.message : String(e));
			}
		};
		const [enabled, setEnabled] = useState(false);
		const [dryRun, setDryRun] = useState(true);
		const [estopKey, setEstopKey] = useState("f12");
		const [windowTitles, setWindowTitles] = useState("");
		const [busyNow, setBusyNow] = useState(false);
		const [running, setRunning] = useState(false);
		/** 陪玩循环是否在跑（由 /autoplay/play 决定，不是本地开关） */
		const [playing, setPlaying] = useState(false);
		const [status, setStatus] = useState("idle");
		const [errText, setErrText] = useState("");
		const statusLine = status === "saving" ? t("saving") : status === "saved" ? t("sightSaved") : status === "error" ? errText : "";
		const [log, setLog] = useState([]);
		const [estopState, setEstopState] = useState({ state: "unknown" });
		const [fg, setFg] = useState("");
		/** 正在运行的窗口（点选白名单用；不用主人手打标题） */
		const [windowChoices, setWindowChoices] = useState([]);
		/** 代打专用识图模型：'' = 跟随对话模型 */
		const [visionProvider, setVisionProvider] = useState("");
		const [visionModelId, setVisionModelId] = useState("");
		const [modelProviders, setModelProviders] = useState([]);
		const reload = useCallback(async () => {
			try {
				const res = await fetch("/dsh-whale-girl/autoplay/config");
				if (!res.ok) return;
				const data = await res.json();
				if (data.config) {
					setEnabled(data.config.enabled === true);
					setDryRun(data.config.dryRun !== false);
					if (typeof data.config.estopKey === "string") setEstopKey(data.config.estopKey);
					if (Array.isArray(data.config.windowTitles)) setWindowTitles(data.config.windowTitles.join("\n"));
					setVisionProvider(typeof data.config.visionModel?.provider === "string" ? data.config.visionModel.provider : "");
					setVisionModelId(typeof data.config.visionModel?.model === "string" ? data.config.visionModel.model : "");
				}
				if (data.estop) setEstopState({
					state: data.estop.state ?? "unknown",
					lastReason: data.estop.lastReason
				});
				try {
					const playRes = await fetch("/dsh-whale-girl/autoplay/play", { cache: "no-store" });
					if (playRes.ok) {
						const playData = await playRes.json();
						setPlaying(playData.play?.running === true);
					}
				} catch {}
			} catch {}
		}, []);
		useEffect(() => {
			reload();
		}, [reload]);
		/**
		
		* 拉「正在运行的窗口」列表。
		
		*
		
		* 白名单靠手打标题太费劲，而且中文游戏名常和窗口英文标题对不上
		
		* （苏丹的游戏 ↔ Sultan's Game）。这里直接列真实窗口，点一下就写进白名单。
		
		*/
		const refreshWindowChoices = useCallback(async () => {
			try {
				const res = await fetch("/dsh-whale-girl/autoplay/windows", { cache: "no-store" });
				if (!res.ok) return;
				const data = await res.json();
				setWindowChoices((data.windows ?? []).filter((w) => typeof w.title === "string" && w.title.trim() !== ""));
			} catch {}
		}, []);
		useEffect(() => {
			refreshWindowChoices();
		}, [refreshWindowChoices]);
		useEffect(() => {
			(async () => {
				try {
					const res = await fetch("/dsh-whale-girl/models", { cache: "no-store" });
					if (!res.ok) return;
					const data = await res.json();
					setModelProviders((data.providers ?? []).map((p) => ({
						id: String(p.id ?? ""),
						name: String(p.name ?? "") || String(p.id ?? ""),
						models: (p.models ?? []).map((m) => ({
							id: String(m.id ?? ""),
							name: String(m.name ?? "") || String(m.id ?? "")
						})).filter((m) => m.id !== "")
					})).filter((p) => p.id !== ""));
				} catch {}
			})();
		}, []);
		/** 保存代打设置（返回错误信息，null = 成功；由顶部统一按钮调用） */
		const save = async () => {
			setStatus("saving");
			setErrText("");
			try {
				const res = await fetch("/dsh-whale-girl/autoplay/config", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						enabled,
						dryRun,
						estopKey,
						windowTitles: windowTitles.split("\n").map((s) => s.trim()).filter((s) => s !== ""),
						visionModel: visionProvider === "" || visionModelId === "" ? null : {
							provider: visionProvider,
							model: visionModelId
						}
					})
				});
				const data = await res.json();
				if (!res.ok || data.ok !== true) {
					const message = data.message ?? `HTTP ${res.status}`;
					setStatus("error");
					setErrText(message);
					return message;
				}
				setStatus("saved");
				await reload();
				return null;
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				setStatus("error");
				setErrText(message);
				return message;
			}
		};
		useEffect(() => {
			registerSave("autoplay", save);
			return () => registerSave("autoplay", null);
		});
		/** 跑一轮（空跑时只是「看一眼 + 打印打算」） */
		const runOnce = async () => {
			setRunning(true);
			setBusyNow(true);
			try {
				const res = await fetch("/dsh-whale-girl/autoplay/run", { method: "POST" });
				const data = await res.json();
				const line = data.kind === "planned" ? `[${data.executed ? "执行" : "空跑"}] ${data.thought ?? ""}` : data.kind === "skipped" ? `[跳过] ${data.reason ?? ""}${data.detail ? "：" + data.detail : ""}` : data.kind === "stopped" ? `[急停] ${data.reason ?? ""}` : `[失败] ${data.message ?? data.reason ?? ""}`;
				setLog((prev) => [new Date().toLocaleTimeString() + " " + line, ...prev].slice(0, 30));
				await reload();
			} catch (e) {
				setLog((prev) => [`[错误] ${e instanceof Error ? e.message : String(e)}`, ...prev].slice(0, 30));
			} finally {
				setRunning(false);
				setBusyNow(false);
			}
		};
		/** 开始陪玩：把表单当前值直接交给宿主并落盘（不依赖顶部「保存」） */
		const startPlay = async () => {
			setBusyNow(true);
			try {
				const titles = windowTitles.split("\n").map((s) => s.trim()).filter((s) => s !== "");
				const res = await fetch("/dsh-whale-girl/autoplay/play/start", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						dryRun,
						estopKey,
						windowTitles: titles,
						visionModel: visionProvider === "" || visionModelId === "" ? null : {
							provider: visionProvider,
							model: visionModelId
						}
					})
				});
				const data = await res.json();
				if (!res.ok || data.ok !== true) {
					setLog((prev) => [`[开始失败] ${data.message ?? "HTTP " + res.status}`, ...prev].slice(0, 30));
					return;
				}
				setEnabled(true);
				setLog((prev) => [`[开始陪玩] ${data.play?.lastMessage ?? "已启动"}`, ...prev].slice(0, 30));
				await reload();
			} catch (e) {
				setLog((prev) => [`[开始失败] ${e instanceof Error ? e.message : String(e)}`, ...prev].slice(0, 30));
			} finally {
				setBusyNow(false);
			}
		};
		/** 停止陪玩：停循环 + 急停 + 把本局压缩进记忆 */
		const stopPlay = async () => {
			setBusyNow(true);
			try {
				const res = await fetch("/dsh-whale-girl/autoplay/play/stop", { method: "POST" });
				const data = await res.json();
				setLog((prev) => [`[已停止] ${data.play?.lastMessage ?? ""}`, ...prev].slice(0, 30));
				await reload();
			} catch (e) {
				setLog((prev) => [`[停止失败] ${e instanceof Error ? e.message : String(e)}`, ...prev].slice(0, 30));
			} finally {
				setBusyNow(false);
			}
		};
		/** 恢复急停（主人手动确认「我允许她继续」） */
		const resume = async () => {
			try {
				await fetch("/dsh-whale-girl/autoplay/resume", { method: "POST" });
				await reload();
			} catch {}
		};
		return h("div", {
			className: "dsh-whale-girl-cfg__card",
			children: [
				h("h3", {
					className: "dsh-whale-girl-cfg__title",
					children: t("playTitle")
				}),
				statusLine === "" ? null : h("p", {
					className: "dsh-whale-girl-cfg__note",
					children: statusLine
				}),
				h("p", {
					className: "dsh-whale-girl-cfg__note",
					children: t("playHint")
				}),
				h("div", {
					className: "dsh-whale-girl-cfg__grid2",
					children: [field(t("playEnabled"), h("label", {
						style: {
							display: "flex",
							gap: "8px",
							alignItems: "center",
							cursor: "pointer"
						},
						children: [h("input", {
							type: "checkbox",
							checked: enabled,
							onChange: (e) => {
								setEnabled(e.target.checked);
								setStatus("idle");
							}
						}), h("span", { children: enabled ? t("playOn") : t("playOff") })]
					}), t("playEnabledHint")), field(t("playDryRun"), h("label", {
						style: {
							display: "flex",
							gap: "8px",
							alignItems: "center",
							cursor: "pointer"
						},
						children: [h("input", {
							type: "checkbox",
							checked: dryRun,
							onChange: (e) => {
								setDryRun(e.target.checked);
								setStatus("idle");
							}
						}), h("span", { children: dryRun ? t("playDryOn") : t("playDryOff") })]
					}), t("playDryHint"))]
				}),
				field(t("playVisionModel"), h("div", {
					style: {
						display: "flex",
						gap: "8px",
						flexWrap: "wrap"
					},
					children: [h("select", {
						className: inputClass,
						value: visionProvider,
						onChange: (e) => {
							setVisionProvider(e.target.value);
							setVisionModelId("");
							setStatus("idle");
						},
						children: [h("option", {
							value: "",
							children: t("playVisionFollow")
						}), ...modelProviders.map((p) => h("option", {
							key: p.id,
							value: p.id,
							children: p.name
						}))]
					}), visionProvider === "" ? null : h("select", {
						className: inputClass,
						value: visionModelId,
						onChange: (e) => {
							setVisionModelId(e.target.value);
							setStatus("idle");
						},
						children: [h("option", {
							value: "",
							children: t("playVisionPickModel")
						}), ...(modelProviders.find((p) => p.id === visionProvider)?.models ?? []).map((m) => h("option", {
							key: m.id,
							value: m.id,
							children: m.name
						}))]
					})]
				}), t("playVisionHint")),
				h("div", {
					className: "dsh-whale-girl-cfg__grid2",
					children: [field(t("playEstopKey"), h("select", {
						className: inputClass,
						value: estopKey,
						onChange: (e) => {
							setEstopKey(e.target.value);
							setStatus("idle");
						},
						children: [
							"f8",
							"f9",
							"f10",
							"f11",
							"f12",
							"esc",
							"pause",
							"scrolllock"
						].map((k) => h("option", {
							key: k,
							value: k,
							children: k.toUpperCase()
						}))
					}), t("playEstopHint")), field(t("playEstopState"), h("div", {
						style: {
							padding: "6px 0",
							color: estopState.state === "ready" ? "var(--dsw-alias-state-success-primary, #2e9e4f)" : "var(--dsw-alias-state-error-primary)"
						},
						children: estopState.state === "ready" ? t("playEstopReady") : t("playEstopStopped") + (estopState.lastReason ? `（${estopState.lastReason}）` : "")
					}), estopState.state === "ready" ? "" : t("playEstopResumeHint"))]
				}),
				estopState.state === "ready" ? null : h("div", {
					className: "dsh-whale-girl-cfg__actions",
					children: [h("button", {
						type: "button",
						className: "dsh-whale-girl-cfg__btn",
						onClick: () => void resume(),
						children: t("playResume")
					})]
				}),
				h("h3", {
					className: "dsh-whale-girl-cfg__title",
					children: t("gameTitle")
				}),
				h("p", {
					className: "dsh-whale-girl-cfg__note",
					children: t("gameHint")
				}),
				h("div", {
					className: "dsh-whale-girl-cfg__grid2",
					children: [
						field(t("gameNameLabel"), h("input", {
							type: "text",
							className: inputClass,
							value: gameTitle,
							placeholder: "群星",
							onChange: (e) => {
								setGameTitle(e.target.value);
								setStatus("idle");
							}
						}), t("gameNameHint")),
						field(t("gameGenreLabel"), h("select", {
							className: inputClass,
							value: gameGenre,
							onChange: (e) => {
								setGameGenre(e.target.value);
								setStatus("idle");
							},
							children: [
								["turn-based", t("gameGenreTurn")],
								["grand-strategy", t("gameGenreStrategy")],
								["tactics", t("gameGenreTactics")],
								["rpg", t("gameGenreRpg")],
								["action", t("gameGenreAction")],
								["custom", t("gameGenreCustom")]
							].map(([v, label]) => h("option", {
								key: v,
								value: v,
								children: label
							}))
						}), t("gameGenreHint")),
						field(t("gameCapLabel"), h("input", {
							type: "number",
							className: inputClass,
							min: 20,
							max: 2e4,
							value: gameCap,
							placeholder: String(genreCaps[gameGenre] ?? 500),
							onChange: (e) => {
								setGameCap(e.target.value);
								setStatus("idle");
							}
						}), t("gameCapHint") + "（" + t("gameCapPreset") + ": " + String(genreCaps[gameGenre] ?? 500) + " 步）")
					]
				}),
				field(t("gameKeysLabel"), h("textarea", {
					className: inputClass,
					rows: 4,
					value: gameKeys,
					placeholder: "暂停=space\n加速=a\n确认=enter",
					onChange: (e) => {
						setGameKeys(e.target.value);
						setStatus("idle");
					}
				}), t("gameKeysHint")),
				field(t("gameNotesLabel"), h("textarea", {
					className: inputClass,
					rows: 3,
					value: gameNotes,
					placeholder: "前期优先科研\n注意人口增长",
					onChange: (e) => {
						setGameNotes(e.target.value);
						setStatus("idle");
					}
				}), t("gameNotesHint")),
				h("div", {
					className: "dsh-whale-girl-cfg__actions",
					children: [
						h("button", {
							type: "button",
							className: "dsh-whale-girl-cfg__btn",
							onClick: () => void saveGame(),
							children: t("gameSave")
						}),
						h("button", {
							type: "button",
							className: "dsh-whale-girl-cfg__btn",
							disabled: guideBusy,
							onClick: () => void lookupGuide(),
							children: guideBusy ? t("gameGuideBusy") : t("gameGuide")
						}),
						gameMsg === "" ? null : h("span", {
							className: "dsh-whale-girl-cfg__note",
							children: gameMsg
						})
					]
				}),
				h("h3", {
					className: "dsh-whale-girl-cfg__title",
					children: t("sessionTitle")
				}),
				h("p", {
					className: "dsh-whale-girl-cfg__note",
					children: sessionText
				}),
				h("div", {
					className: "dsh-whale-girl-cfg__actions",
					children: [h("button", {
						type: "button",
						className: "dsh-whale-girl-cfg__btn",
						onClick: () => void endSession(),
						children: t("sessionEnd")
					})]
				}),
				field(t("playWindows"), h("textarea", {
					className: inputClass,
					rows: 3,
					value: windowTitles,
					placeholder: "星露谷物语\n群星",
					onChange: (e) => {
						setWindowTitles(e.target.value);
						setStatus("idle");
					}
				}), t("playWindowsHint")),
				h("div", {
					className: "dsh-whale-girl-cfg__actions",
					children: [h("select", {
						className: inputClass,
						value: "",
						onChange: (e) => {
							const title = e.target.value;
							if (title === "") return;
							setWindowTitles((prev) => {
								const lines = prev.split("\n").map((s) => s.trim()).filter((s) => s !== "");
								if (!lines.includes(title)) lines.push(title);
								return lines.join("\n");
							});
							setStatus("idle");
						},
						children: [h("option", {
							value: "",
							children: t("playPickWindow")
						}), ...windowChoices.map((w) => h("option", {
							key: String(w.pid ?? w.title) + "|" + w.title,
							value: w.title,
							children: w.title + (w.processName !== void 0 && w.processName !== "" ? "（" + w.processName + "）" : "")
						}))]
					}), h("button", {
						type: "button",
						className: "dsh-whale-girl-cfg__btn",
						onClick: () => void refreshWindowChoices(),
						children: t("playRefreshWindows")
					})]
				}),
				h("div", {
					className: "dsh-whale-girl-cfg__actions",
					children: [
						h("button", {
							type: "button",
							className: "dsh-whale-girl-cfg__btn",
							onClick: () => {
								(async () => {
									try {
										const res = await fetch("/dsh-whale-girl/autoplay/foreground");
										const data = await res.json();
										setFg(data.title ?? "");
									} catch {
										setFg("");
									}
								})();
							},
							children: t("playCheckWindow")
						}),
						h("button", {
							type: "button",
							className: "dsh-whale-girl-cfg__btn",
							onClick: () => {
								(async () => {
									try {
										const res = await fetch("/dsh-whale-girl/autoplay/foreground");
										const data = await res.json();
										const title = (data.title ?? "").trim();
										if (title === "") return;
										setWindowTitles((prev) => {
											const lines = prev.split("\n").map((s) => s.trim()).filter((s) => s !== "");
											if (!lines.includes(title)) lines.push(title);
											return lines.join("\n");
										});
										setStatus("idle");
									} catch {}
								})();
							},
							children: t("playAddWindow")
						}),
						fg === "" ? null : h("span", {
							className: "dsh-whale-girl-cfg__note",
							children: `「${fg}」`
						})
					]
				}),
				h("div", {
					className: "dsh-whale-girl-cfg__actions",
					children: [h("button", {
						type: "button",
						className: "dsh-whale-girl-cfg__btn",
						disabled: busyNow,
						onClick: () => void (playing ? stopPlay() : startPlay()),
						children: playing ? t("playStop") : t("playStart")
					}), playing ? h("span", {
						className: "dsh-whale-girl-cfg__note",
						children: t("playLoopOn")
					}) : null]
				}),
				h("div", {
					className: "dsh-whale-girl-cfg__actions",
					children: [
						h("button", {
							type: "button",
							className: "dsh-whale-girl-cfg__btn",
							disabled: busyNow,
							onClick: () => void runOnce(),
							children: running ? t("playRunning") : t("playRunNow")
						}),
						status === "saved" ? h("span", {
							className: "dsh-whale-girl-cfg__note",
							children: t("sightSaved")
						}) : null,
						status === "error" ? h("span", {
							className: "dsh-whale-girl-cfg__note",
							style: { color: "var(--dsw-alias-state-error-primary)" },
							children: errText
						}) : null
					]
				}),
				h("p", {
					className: "dsh-whale-girl-cfg__note",
					children: t("playLog")
				}),
				log.length === 0 ? h("p", {
					className: "dsh-whale-girl-cfg__note",
					children: t("playLogEmpty")
				}) : h("div", {
					style: {
						marginTop: "6px",
						maxHeight: "180px",
						overflowY: "auto",
						fontFamily: MONO,
						fontSize: "12px",
						lineHeight: 1.6,
						background: "rgba(0,0,0,.18)",
						borderRadius: "6px",
						padding: "8px"
					},
					children: log.map((line, i) => h("div", {
						key: i,
						children: line
					}))
				})
			]
		});
	};
	return function PetConfigSection() {
		const initPets = petBridge.current.filter((p) => !p.extra);
		const extraCount = petBridge.current.filter((p) => p.extra).length;
		const [pets, setPets] = useState(initPets.map((p) => ({
			...p,
			position: { ...p.position }
		})));
		const [selId, setSelId] = useState(initPets[0]?.id ?? "");
		const [saving, setBusy] = useState(false);
		/**
		
		* 设置页当前页签。
		
		*
		
		* 为什么要有它：功能模块越加越多（宠物 / 外观 / AI / 语音 / 识屏 / 代打 / 存储），
		
		* 全铺在一页上要滚很久才找得到东西（主人原话：「滑下去都要不少时间」）。
		
		* 现在按页签分组，每页只显示相关的那几块。
		
		*
		
		* 注意：**只影响显示，不影响保存**——「保存」始终整包写入所有页的值，
		
		* 切页不会丢改动（这是分组最容易踩的坑）。
		
		*/
		const [page, setPage] = useState("pet");
		/** 按页签过滤：不属于当前页就返回 null（而不是不渲染——保持元素结构稳定） */
		const only = (target, node) => page === target ? node : null;
		const [loadState, setLoadState] = useState("loading");
		const [loadAttempt, setLoadAttempt] = useState(0);
		/**
		
		* 四个模块的保存函数登记表。
		
		*
		
		* 为什么用登记：四块配置存在**四个不同文件**（main-config / voice.json /
		
		* sight.json / autoplay.json），字段形状也完全不同。硬把状态提到这里，
		
		* 这个组件会变成一个巨型 state 容器。登记让每块自己管表单，只把
		
		* 「怎么保存」交出去，顶部一个按钮统一触发。
		
		*/
		const saversRef = useRef(new Map());
		const registerSave = useCallback((name, fn) => {
			if (fn === null) saversRef.current.delete(name);
			else saversRef.current.set(name, fn);
		}, []);
		/** 顶部「保存全部」的状态与汇总信息 */
		const [saveAll, setSaveAll] = useState({
			kind: "idle",
			text: ""
		});
		/**
		
		* 一次保存全部四份配置：宠物 / 语音 / 识屏 / 代打。
		
		*
		
		* 四个模块各自登记了自己的保存函数（见 saversRef），这里按顺序调一遍。
		
		* 任一处失败都**继续保存其余部分**（能存的先存上），最后把失败原因汇总显示——
		
		* 中途 abort 会让前面已经算好的改动白做。
		
		*/
		const runSaveAll = async () => {
			setSaveAll({
				kind: "saving",
				text: ""
			});
			const failures = [];
			try {
				const err = await save();
				if (err !== null) failures.push(`宠物配置：${err}`);
			} catch (e) {
				failures.push(`宠物配置：${e instanceof Error ? e.message : String(e)}`);
			}
			for (const [name, fn] of saversRef.current) try {
				const err = await fn();
				if (err !== null) failures.push(`${name}：${err}`);
			} catch (e) {
				failures.push(`${name}：${e instanceof Error ? e.message : String(e)}`);
			}
			if (failures.length === 0) setSaveAll({
				kind: "ok",
				text: t("saveAllDone")
			});
			else setSaveAll({
				kind: "err",
				text: failures.join("；")
			});
		};
		const busy = saving || loadState !== "ready";
		const [msg, setMsg] = useState({
			kind: "",
			text: ""
		});
		const [dialog, setDialog] = useState(null);
		const [paths, setPaths] = useState(null);
		useEffect(() => {
			fetch("/dsh-whale-girl/config/meta").then((r) => r.ok ? r.json() : null).then((p) => setPaths(p)).catch(() => console.warn("[dsh-whale-girl] 读取配置文件路径失败"));
		}, []);
		const [notifyEnabled$1, setNotifyEnabled] = useState(true);
		const [whisperImage, setWhisperImage] = useState(false);
		const [chatImage, setChatImage] = useState(false);
		const [confineScreen, setConfineScreen] = useState(false);
		const [physics, setPhysics] = useState({ ...DEFAULT_PHYSICS });
		const [font, setFont] = useState({ ...DEFAULT_FONT });
		const [whisperModel, setWhisperModel] = useState({
			provider: "",
			model: ""
		});
		const [chatModel, setChatModel] = useState({
			provider: "",
			model: ""
		});
		const [chatMemory, setChatMemory] = useState(5);
		const [chatImageLimit, setChatImageLimit] = useState(10);
		const [catalog, setCatalog] = useState(null);
		const [catalogErr, setCatalogErr] = useState(false);
		const [permMsg, setPermMsg] = useState({
			kind: "",
			text: ""
		});
		const applyConfig = useCallback((merged) => {
			const m = merged.main;
			if (!m || !Array.isArray(m.pets)) throw new Error("Invalid config response");
			const loadedPets = m.pets;
			setPets(loadedPets.map((p) => ({
				...p,
				position: { ...p.position }
			})));
			setSelId((id) => loadedPets.some((p) => p.id === id) ? id : loadedPets[0]?.id ?? "");
			if (typeof m.notificationsEnabled === "boolean") setNotifyEnabled(m.notificationsEnabled);
			if (typeof m.whisperImageEnabled === "boolean") setWhisperImage(m.whisperImageEnabled);
			if (typeof m.chatImageEnabled === "boolean") setChatImage(m.chatImageEnabled);
			if (typeof m.confineToScreen === "boolean") setConfineScreen(m.confineToScreen);
			if (m.physics && typeof m.physics === "object") setPhysics({
				...DEFAULT_PHYSICS,
				...m.physics
			});
			if (m.font && typeof m.font === "object") setFont({
				...DEFAULT_FONT,
				...m.font
			});
			const wm = m.whisperModel;
			if (wm && typeof wm.provider === "string" && typeof wm.model === "string") setWhisperModel({
				provider: wm.provider,
				model: wm.model
			});
			const cm = m.chatModel;
			if (cm && typeof cm.provider === "string" && typeof cm.model === "string") setChatModel({
				provider: cm.provider,
				model: cm.model
			});
			const cmr = Number(m.chatMemoryRounds);
			if (Number.isFinite(cmr) && cmr >= 0) setChatMemory(cmr);
			const cil = Number(m.chatImageLimit);
			if (Number.isFinite(cil) && cil >= 0) setChatImageLimit(cil);
		}, []);
		useEffect(() => {
			let alive = true;
			const controller = new AbortController();
			fetch("/dsh-whale-girl/config", { signal: controller.signal }).then((r) => {
				if (!r.ok) throw new Error("HTTP " + r.status);
				return r.json();
			}).then((merged) => {
				if (!alive) return;
				applyConfig(merged);
				setLoadState("ready");
			}).catch(() => {
				if (alive) setLoadState("error");
			});
			return () => {
				alive = false;
				controller.abort();
			};
		}, [applyConfig, loadAttempt]);
		useEffect(() => {
			let alive = true;
			fetch("/dsh-whale-girl/models").then((r) => r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))).then((d) => {
				if (!alive) return;
				if (d && Array.isArray(d.providers)) setCatalog(d.providers);
				else setCatalogErr(true);
			}).catch(() => {
				if (alive) setCatalogErr(true);
			});
			return () => {
				alive = false;
			};
		}, []);
		const toggleNotify = async (v) => {
			setNotifyEnabled(v);
			if (v) await requestNotificationPermission();
		};
		/**
		
		* 「测试弹窗」按钮：发一条测试系统通知，验证整条链路通不通。
		
		*
		
		* 顺带承担申请权限的职责——没授权时先申请（借这次用户手势，无手势的自动申请可能被浏览器
		
		* 静默压制），授权成功再发测试通知。所以这一个按钮同时是「拿权限」和「验链路」的入口，
		
		* 不需要再单独摆一个「获取权限」按钮。
		
		*/
		const testNotification = async () => {
			setPermMsg({
				kind: "",
				text: ""
			});
			const r = await requestNotificationPermission();
			if (!r.ok) {
				const reason = r.reason === "unsupported" ? t("notifyDenyUnsupported") : r.reason === "denied" ? t("notifyDenyBlocked") : r.reason === "rejected" ? t("notifyDenyRejected") : t("notifyDenyError") + (r.message ? "：" + r.message : "");
				setPermMsg({
					kind: "err",
					text: reason + (r.reason === "unsupported" ? "" : " " + t("notifyGuide"))
				});
				return;
			}
			try {
				new Notification("测试通知", {
					body: "【dsh-whale-girl】系统通知已就绪。",
					icon: NOTIFY_ICONS.test
				});
			} catch {}
			setPermMsg({
				kind: "ok",
				text: t("notifyTestOk")
			});
		};
		const cur = pets.find((p) => p.id === selId) ?? null;
		const updateSel = (patch) => setPets((list) => list.map((p) => {
			if (p.id !== selId) return p;
			const { position: posPatch,...rest } = patch;
			return {
				...p,
				...rest,
				position: posPatch ? {
					...p.position,
					...posPatch
				} : p.position
			};
		}));
		const validated = () => {
			for (const p of pets) if (!Number.isFinite(p.size) || p.size <= 0 || !Number.isFinite(p.position.marginX) || !Number.isFinite(p.position.marginY)) {
				setMsg({
					kind: "err",
					text: t("invalid")
				});
				return false;
			}
			if (!Number.isFinite(physics.gravity) || physics.gravity < 0 || !Number.isFinite(physics.restitution) || physics.restitution < 0 || physics.restitution > 1 || !Number.isFinite(physics.groundFriction) || physics.groundFriction < 0 || !Number.isFinite(physics.throwPower) || physics.throwPower <= 0) {
				setMsg({
					kind: "err",
					text: t("invalidPhysics")
				});
				return false;
			}
			if (!modelPairValid(whisperModel) || !modelPairValid(chatModel)) {
				setMsg({
					kind: "err",
					text: t("invalidModel")
				});
				return false;
			}
			if (!Number.isFinite(chatMemory) || chatMemory < 0) {
				setMsg({
					kind: "err",
					text: t("invalidChatMemory")
				});
				return false;
			}
			if (!Number.isFinite(chatImageLimit) || chatImageLimit < 0) {
				setMsg({
					kind: "err",
					text: t("invalidChatImageLimit")
				});
				return false;
			}
			if (!FONT_PRESETS.some((p) => p.id === font.family) || !Number.isFinite(font.size) || font.size < FONT_SIZE_MIN || font.size > FONT_SIZE_MAX) {
				setMsg({
					kind: "err",
					text: t("invalidFont")
				});
				return false;
			}
			return true;
		};
		/** 保存宠物配置。返回错误信息（null = 成功），供顶部「保存全部」汇总 */
		const save = async (force = false) => {
			if (busy) return "正在保存中";
			const isOk = validated();
			if (!isOk) return "宠物配置有误，请检查红字提示";
			setBusy(true);
			setMsg({
				kind: "",
				text: ""
			});
			try {
				const body = {
					pets,
					notificationsEnabled: notifyEnabled$1,
					whisperImageEnabled: whisperImage,
					chatImageEnabled: chatImage,
					confineToScreen: confineScreen,
					physics,
					whisperModel,
					chatModel,
					chatMemoryRounds: chatMemory,
					chatImageLimit,
					font
				};
				const res = await fetch("/dsh-whale-girl/config" + (force === true ? "?force=1" : ""), {
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body)
				});
				if (res.status === 409) {
					const info = await res.json().catch(() => null);
					setDialog({
						kind: "corrupt",
						path: typeof info?.userFile === "string" ? info.userFile : paths?.user ?? ""
					});
					return "配置文件损坏，需要你确认后重建";
				}
				if (!res.ok) throw new Error("HTTP " + res.status);
				petBridge.reload(await res.json());
				reloadNotifications();
				setMsg({
					kind: "ok",
					text: t("saved")
				});
				return null;
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				setMsg({
					kind: "err",
					text: t("loadError")
				});
				return message;
			} finally {
				setBusy(false);
			}
		};
		const sync = () => setDialog({ kind: "sync" });
		const doSync = async () => {
			setBusy(true);
			setMsg({
				kind: "",
				text: ""
			});
			try {
				const res = await fetch("/dsh-whale-girl/config", { method: "POST" });
				if (!res.ok) throw new Error("HTTP " + res.status);
				const merged = await res.json();
				applyConfig(merged);
				petBridge.reload(merged);
				reloadNotifications();
				setMsg({
					kind: "ok",
					text: t("saved")
				});
				return null;
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				setMsg({
					kind: "err",
					text: t("loadError")
				});
				return message;
			} finally {
				setBusy(false);
			}
		};
		const addPet = () => {
			const tpl = petBridge.template;
			if (!tpl) return;
			const id = nextId(pets);
			setPets((list) => [...list, {
				id,
				name: id,
				size: tpl.size,
				balanceEnabled: tpl.balanceEnabled,
				whisperEnabled: tpl.whisperEnabled,
				workStatusEnabled: tpl.workStatusEnabled,
				fixedEnabled: tpl.fixedEnabled,
				display: tpl.display,
				position: { ...tpl.position }
			}]);
			setSelId(id);
		};
		const removeSel = () => {
			setDialog({ kind: pets.length <= 1 ? "lastOne" : "remove" });
		};
		const doRemove = () => {
			const list = pets.filter((p) => p.id !== selId);
			setPets(list);
			setSelId(list[0].id);
		};
		/** 宠物数值输入（大小 / 水平偏移 / 垂直偏移）——宽度交给栅格，不再各自写死 */
		const numInput = (key, value, setter) => h("input", {
			type: "number",
			className: inputClass,
			step: key === "size" ? "10" : "1",
			min: key === "size" ? "120" : "",
			value: String(value),
			disabled: busy,
			onChange: (e) => setter(Number(e.target.value))
		});
		/** 物理参数的一格：标签 + 问号在上、数字输入在下（说明进问号） */
		const physField = (key, step, min, end = false) => field(t("physics." + key), h("input", {
			type: "number",
			className: inputClass,
			step,
			min,
			value: String(physics[key]),
			disabled: busy,
			onChange: (e) => setPhysics((p) => ({
				...p,
				[key]: Number(e.target.value)
			}))
		}), t("physics." + key + "Hint"), end);
		/** 「全局默认」的一个数字格：标签 + 问号在上、数字输入在下（说明 = t(label + 'Hint') 进问号） */
		const globalNumField = (label, value, setter) => field(t(label), h("input", {
			type: "number",
			className: inputClass,
			step: "1",
			min: "0",
			value: String(value),
			disabled: busy,
			onChange: (e) => setter(Number(e.target.value))
		}), t(label + "Hint"));
		/** 「AI 模型」的一格：标签 + 问号在上、单下拉选择器在下 */
		const modelCell = (key, value, setter, end = false) => {
			const label = t(key === "whisperModel" ? "whisperModelLabel" : "chatModelLabel");
			return field(label, h(ModelPicker, {
				label,
				value,
				disabled: busy,
				catalog,
				failed: catalogErr,
				onChange: setter
			}), t("modelFieldHint"), end);
		};
		return h("section", {
			className: "dsh-whale-girl-cfg",
			style: { maxWidth: "720px" },
			children: [
				h("h2", {
					className: "dsh-whale-girl-cfg__title",
					children: [t("nav"), q(extraCount > 0 ? t("intro") + "\n" + t("extraPetsHint").replace("{n}", String(extraCount)) : t("intro"))]
				}),
				h("div", {
					className: "dsh-whale-girl-cfg__saveBar",
					children: [
						h("button", {
							type: "button",
							disabled: busy || saveAll.kind === "saving",
							onClick: () => void runSaveAll(),
							className: "dsh-whale-girl-cfg__btn is-primary",
							children: saveAll.kind === "saving" ? t("saving") : t("saveAll")
						}),
						saveAll.text === "" ? null : h("span", {
							className: "dsh-whale-girl-cfg__msg" + (saveAll.kind === "err" ? " is-err" : ""),
							children: saveAll.text
						}),
						h("span", {
							className: "dsh-whale-girl-cfg__note",
							children: t("saveAllHint")
						})
					]
				}),
				h("div", {
					className: "dsh-whale-girl-cfg__card",
					children: [
						cardHead(t("modelTitle"), t("modelHint")),
						catalogErr ? h("p", {
							className: "dsh-whale-girl-cfg__note",
							style: { color: "var(--dsw-alias-state-error-primary)" },
							children: t("modelCatalogFailed")
						}) : null,
						h("div", {
							className: "dsh-whale-girl-cfg__grid2",
							children: [modelCell("whisperModel", whisperModel, setWhisperModel), modelCell("chatModel", chatModel, setChatModel, true)]
						}),
						h("p", {
							className: "dsh-whale-girl-cfg__note",
							children: t("modelSharedHint")
						}),
						h("div", {
							className: "dsh-whale-girl-cfg__grid4",
							children: [globalNumField("chatMemory", chatMemory, setChatMemory), globalNumField("chatImageLimit", chatImageLimit, setChatImageLimit)]
						})
					]
				}),
				h("div", {
					className: "dsh-whale-girl-cfg__pageTabs",
					role: "tablist",
					children: [
						"pet",
						"look",
						"voice",
						"log",
						"sight",
						"play",
						"more"
					].map((id) => h("button", {
						key: id,
						type: "button",
						role: "tab",
						"aria-selected": page === id,
						className: "dsh-whale-girl-cfg__pageTab" + (page === id ? " is-active" : ""),
						onClick: () => setPage(id),
						children: t("page_" + id)
					}))
				}),
				loadState !== "ready" ? h("div", {
					role: loadState === "error" ? "alert" : "status",
					className: "dsh-whale-girl-cfg__actions",
					children: [h("span", { children: t(loadState === "error" ? "loadError" : "loading") }), loadState === "error" ? h("button", {
						type: "button",
						className: "dsh-whale-girl-cfg__btn",
						onClick: () => {
							setLoadState("loading");
							setLoadAttempt((attempt) => attempt + 1);
						},
						children: t("retry")
					}) : null]
				}) : null,
				only("pet", h("div", {
					className: "dsh-whale-girl-cfg__tabs",
					children: [
						h("span", {
							key: "label",
							className: "dsh-whale-girl-cfg__tabsLabel",
							children: t("petsLabel")
						}),
						...pets.map((p) => h("button", {
							key: p.id,
							type: "button",
							onClick: () => setSelId(p.id),
							className: "dsh-whale-girl-cfg__tab" + (p.id === selId ? " is-active" : ""),
							children: (p.name || p.id) + " (" + p.size + "px)"
						})),
						h("button", {
							key: "add",
							type: "button",
							onClick: addPet,
							disabled: busy,
							className: "dsh-whale-girl-cfg__tab is-ghost",
							children: "+ " + t("add")
						})
					]
				})),
				only("pet", cur ? h("div", {
					className: "dsh-whale-girl-cfg__card",
					children: [
						h("div", {
							className: "dsh-whale-girl-cfg__cardHead",
							children: [
								h("span", {
									key: "t",
									className: "dsh-whale-girl-cfg__cardTitle",
									children: t("petCardTitle")
								}),
								q(t("petCardHint")),
								h("button", {
									key: "rm",
									type: "button",
									onClick: removeSel,
									disabled: busy,
									className: "dsh-whale-girl-cfg__btn is-danger is-sm",
									style: { marginLeft: "auto" },
									children: t("remove")
								})
							]
						}),
						h("div", {
							className: "dsh-whale-girl-cfg__grid3",
							children: [
								field(t("nameLabel"), h("input", {
									type: "text",
									className: inputClass,
									value: String(cur.name ?? ""),
									disabled: busy,
									maxLength: 50,
									onChange: (e) => updateSel({ name: e.target.value })
								}), t("nameHint")),
								field(t("sizeLabel"), numInput("size", cur.size, (v) => updateSel({ size: v })), t("sizeHint")),
								field(t("displayLabel"), h("select", {
									className: inputClass,
									value: cur.display,
									disabled: busy,
									onChange: (e) => updateSel({ display: e.target.value }),
									children: PET_DISPLAYS.map((d) => h("option", {
										key: d,
										value: d,
										children: t("display." + d)
									}))
								}), t("displayHint"), true)
							]
						}),
						h("div", {
							className: "dsh-whale-girl-cfg__grid3",
							children: [
								field(t("cornerLabel"), h("select", {
									className: inputClass,
									value: cur.position.corner,
									disabled: busy,
									onChange: (e) => updateSel({ position: { corner: e.target.value } }),
									children: CORNERS.map((c) => h("option", {
										key: c,
										value: c,
										children: cornerLabel(c)
									}))
								}), t("cornerHint")),
								field(t("marginX"), numInput("marginX", cur.position.marginX, (v) => updateSel({ position: { marginX: v } })), t("marginXHint")),
								field(t("marginY"), numInput("marginY", cur.position.marginY, (v) => updateSel({ position: { marginY: v } })), t("marginYHint"), true)
							]
						}),
						h("div", {
							className: "dsh-whale-girl-cfg__grid4",
							children: [
								toggleCell("balanceEnabled", !!cur.balanceEnabled, busy, (v) => updateSel({ balanceEnabled: v })),
								toggleCell("whisperEnabled", !!cur.whisperEnabled, busy, (v) => updateSel({ whisperEnabled: v })),
								toggleCell("workStatusEnabled", !!cur.workStatusEnabled, busy, (v) => updateSel({ workStatusEnabled: v })),
								toggleCell("fixedEnabled", !!cur.fixedEnabled, busy, (v) => updateSel({ fixedEnabled: v }), true)
							]
						})
					]
				}) : h("p", {
					className: "dsh-whale-girl-cfg__note",
					children: t("emptyPets")
				})),
				only("look", h("div", {
					className: "dsh-whale-girl-cfg__card",
					children: [cardHead(t("globalTitle"), t("globalHint")), h("div", {
						className: "dsh-whale-girl-cfg__grid4",
						children: [
							toggleCell("notifyToggle", notifyEnabled$1, busy, (v) => void toggleNotify(v)),
							toggleCell("whisperImageToggle", whisperImage, busy, setWhisperImage),
							toggleCell("chatImageToggle", chatImage, busy, setChatImage),
							toggleCell("confineToggle", confineScreen, busy, setConfineScreen, true)
						]
					})]
				})),
				only("look", h("div", {
					className: "dsh-whale-girl-cfg__card",
					children: [
						cardHead(t("fontTitle"), t("fontHint")),
						h("div", {
							className: "dsh-whale-girl-cfg__grid2",
							children: [field(t("fontFamilyLabel"), h("select", {
								className: inputClass,
								value: font.family,
								disabled: busy,
								onChange: (e) => setFont((f) => ({
									...f,
									family: e.target.value
								})),
								children: FONT_PRESETS.map((p) => h("option", {
									key: p.id,
									value: p.id,
									children: t("font." + p.id)
								}))
							}), t("fontFamilyHint")), field(t("fontSizeLabel"), h("input", {
								type: "number",
								className: inputClass,
								step: "1",
								min: String(FONT_SIZE_MIN),
								max: String(FONT_SIZE_MAX),
								value: String(font.size),
								disabled: busy,
								onChange: (e) => setFont((f) => ({
									...f,
									size: Number(e.target.value)
								}))
							}), t("fontSizeHint"), true)]
						}),
						h("div", {
							className: "dsh-whale-girl-cfg__grid2",
							children: [toggleCell("fontFollowToggle", font.followPet, busy, (v) => setFont((f) => ({
								...f,
								followPet: v
							})))]
						})
					]
				})),
				h("div", {
					key: "voice",
					style: { display: page === "voice" ? "contents" : "none" },
					children: [h(VoiceSettingsCard, {
						key: "voice-card",
						registerSave
					}), h(MemoryPersonaCard, { key: "memory-card" })]
				}),
				h("div", {
					key: "log",
					style: { display: page === "log" ? "contents" : "none" },
					children: h(ChatLogCard, {})
				}),
				h("div", {
					key: "sight",
					style: { display: page === "sight" ? "contents" : "none" },
					children: h(SightSettingsCard, { registerSave })
				}),
				h("div", {
					key: "play",
					style: { display: page === "play" ? "contents" : "none" },
					children: h(AutoplaySettingsCard, { registerSave })
				}),
				only("look", h("div", {
					className: "dsh-whale-girl-cfg__card",
					children: [
						cardHead(t("physicsTitle"), t("physicsHint")),
						h("div", {
							className: "dsh-whale-girl-cfg__grid4",
							children: [
								physField("gravity", "50", "0"),
								physField("restitution", "0.01", "0"),
								physField("groundFriction", "0.1", "0"),
								physField("throwPower", "0.05", "0.05", true)
							]
						}),
						h("div", {
							className: "dsh-whale-girl-cfg__grid2",
							children: [toggleCell("physicsCeilingBounce", physics.ceilingBounce, busy, (v) => setPhysics((p) => ({
								...p,
								ceilingBounce: v
							}))), toggleCell("physicsPetCollision", physics.petCollision, busy, (v) => setPhysics((p) => ({
								...p,
								petCollision: v
							})), true)]
						})
					]
				})),
				h("div", {
					className: "dsh-whale-girl-cfg__actions",
					children: [
						h("button", {
							type: "button",
							disabled: busy,
							onClick: sync,
							className: "dsh-whale-girl-cfg__btn",
							children: t("sync")
						}),
						h("button", {
							type: "button",
							onClick: () => void testNotification(),
							className: "dsh-whale-girl-cfg__btn",
							children: t("notifyTest")
						}),
						q(t("syncHint")),
						msg.text ? h("span", {
							className: "dsh-whale-girl-cfg__msg" + (msg.kind === "err" ? " is-err" : ""),
							children: msg.text
						}) : null,
						permMsg.text ? h("span", {
							className: "dsh-whale-girl-cfg__msg" + (permMsg.kind === "err" ? " is-err" : ""),
							children: permMsg.text
						}) : null
					]
				}),
				only("more", h(AppsCard, { key: "apps" })),
				only("more", paths ? h("div", {
					className: "dsh-whale-girl-cfg__card",
					children: [
						cardHead(t("configMeta"), t("configMetaHint")),
						h("div", {
							className: "dsh-whale-girl-cfg__path",
							children: t("defaultConfig") + "：" + paths.default
						}),
						h("div", {
							className: "dsh-whale-girl-cfg__path",
							children: t("userConfig") + "：" + paths.user
						}),
						h("div", {
							className: "dsh-whale-girl-cfg__path",
							children: t("animationDir") + "：" + paths.animations
						}),
						paths.memes ? h("div", {
							className: "dsh-whale-girl-cfg__path",
							children: t("memesDir") + "：" + paths.memes
						}) : null
					]
				}) : null),
				only("more", paths && paths.storage && paths.storage.length > 0 ? h("div", {
					className: "dsh-whale-girl-cfg__card",
					children: [
						cardHead(t("storageTitle"), t("storageHint")),
						...paths.storage.map((s) => h("div", {
							key: s.key,
							className: "dsh-whale-girl-cfg__path",
							children: [h("b", {
								key: "p",
								style: { fontFamily: MONO },
								children: s.path
							}), h("span", {
								key: "d",
								children: " — " + t("storage." + s.key) + (s.exists === false ? t("storageMissing") : "")
							})]
						})),
						h("div", {
							key: "ut",
							className: "dsh-whale-girl-cfg__cardTitle",
							style: { marginTop: "4px" },
							children: t("uninstallTitle")
						}),
						h("div", {
							key: "u1",
							className: "dsh-whale-girl-cfg__note",
							children: t("uninstallStep1")
						}),
						h("div", {
							key: "u2",
							className: "dsh-whale-girl-cfg__note",
							children: t("uninstallStep2")
						}),
						h("div", {
							key: "cmd",
							className: "dsh-whale-girl-cfg__cmd",
							children: t("uninstallCmd").replace("{profile}", paths.profile || "<profile>")
						}),
						h("div", {
							key: "u3",
							className: "dsh-whale-girl-cfg__note",
							children: t("uninstallStep3")
						})
					]
				}) : null),
				dialog ? h("div", {
					style: {
						position: "fixed",
						inset: 0,
						zIndex: 2147483647,
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
						background: "rgba(0, 0, 0, 0.45)"
					},
					onClick: () => setDialog(null),
					children: h("div", {
						style: {
							width: "340px",
							maxWidth: "calc(100vw - 40px)",
							background: "var(--dsw-alias-bg-layer-1)",
							border: "1px solid var(--dsw-alias-border-l2)",
							borderRadius: "12px",
							padding: "16px 18px",
							boxShadow: "0 8px 30px rgba(0, 0, 0, 0.35)",
							display: "flex",
							flexDirection: "column",
							gap: "12px"
						},
						onClick: (e) => e.stopPropagation(),
						children: [
							h("div", {
								style: {
									fontSize: "14px",
									fontWeight: 500,
									color: "var(--dsw-alias-label-primary)"
								},
								children: dialog.kind === "corrupt" ? t("corruptTitle") : t("confirmTitle")
							}),
							h("div", {
								style: {
									fontSize: "13px",
									lineHeight: "20px",
									color: "var(--dsw-alias-label-secondary)"
								},
								children: dialog.kind === "remove" ? t("confirmRemove").replace("{id}", selId) : dialog.kind === "lastOne" ? t("atLeastOne") : dialog.kind === "corrupt" ? t("corruptBody").replace("{path}", dialog.path) : t("confirmSync")
							}),
							h("div", {
								style: {
									display: "flex",
									gap: "8px",
									justifyContent: "flex-end"
								},
								children: dialog.kind === "lastOne" ? [h("button", {
									key: "ok",
									type: "button",
									onClick: () => setDialog(null),
									className: "dsh-whale-girl-cfg__btn is-primary",
									children: t("ok")
								})] : [h("button", {
									key: "cancel",
									type: "button",
									onClick: () => setDialog(null),
									className: "dsh-whale-girl-cfg__btn",
									children: t("cancel")
								}), h("button", {
									key: "confirm",
									type: "button",
									onClick: () => {
										const d = dialog;
										setDialog(null);
										if (d.kind === "remove") doRemove();
										else if (d.kind === "corrupt") save(true);
										else doSync();
									},
									className: "dsh-whale-girl-cfg__btn " + (dialog.kind === "sync" ? "is-primary" : "is-danger"),
									children: dialog.kind === "remove" ? t("remove") : dialog.kind === "corrupt" ? t("corruptConfirm") : t("sync")
								})]
							})
						]
					})
				}) : null
			]
		});
	};
}

//#endregion
//#region src/client/pet.ts
const statePoller = { now: () => {} };
/** 播放动画扩展名 = 共享常量（src/shared/constants.ts 的 ANIMATION_EXT，默认 .webm）。

*  macOS Safari/WKWebView 需改共享常量/产物为 .mov（HEVC-with-Alpha）后自构建。 */
const THUMB_EXT = ANIMATION_EXT;
/** 余额气泡展示时长（ms）：定时自动消失，与动画生命周期解耦 */
const BUBBLE_DURATION_MS = 10 * 1e3;
/** 内联 CSS —— 注入一次（官方插件标准做法） */
const css = [
	".dsh-whale-girl-root{position:fixed;z-index:40;pointer-events:none;user-select:none}",
	".dsh-whale-girl-root[data-corner=\"bottom-right\"]{right:var(--dsh-whale-girl-mx,24px);bottom:var(--dsh-whale-girl-my,0)}",
	".dsh-whale-girl-root[data-corner=\"bottom-left\"]{left:var(--dsh-whale-girl-mx,24px);bottom:var(--dsh-whale-girl-my,0)}",
	".dsh-whale-girl-root[data-corner=\"top-right\"]{right:var(--dsh-whale-girl-mx,24px);top:var(--dsh-whale-girl-my,0)}",
	".dsh-whale-girl-root[data-corner=\"top-left\"]{left:var(--dsh-whale-girl-mx,24px);top:var(--dsh-whale-girl-my,0)}",
	".dsh-whale-girl-stage{position:relative;width:var(--dsh-whale-girl-size,462px);height:calc(var(--dsh-whale-girl-size,462px)*9/16);pointer-events:none}",
	".dsh-whale-girl-video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none;opacity:0;transition:opacity .18s ease;transform-origin:center}",
	".dsh-whale-girl-video.is-front{opacity:1}",
	".dsh-whale-girl-hit{position:absolute;pointer-events:auto;cursor:url(\"/dsh-whale-girl/pic/cursor-grab.png\") 16 16, grab;z-index:1;touch-action:none;-webkit-user-select:none;-webkit-touch-callout:none}",
	".dsh-whale-girl-hit.dragging{cursor:url(\"/dsh-whale-girl/pic/cursor-grabbing.png\") 16 16, grabbing}",
	"@media (prefers-reduced-motion: reduce){.dsh-whale-girl-video{transition:none}}",
	MENU_CSS,
	TOOLTIP_CSS
].join("\n");
const cssTag = "dsh-whale-girl/style.css";
function injectCss$1() {
	if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=\"" + cssTag + "\"]") === null) {
		const tag = document.createElement("style");
		tag.dataset.plugin = "dsh-whale-girl";
		tag.dataset.pluginCss = cssTag;
		tag.textContent = css;
		document.head.appendChild(tag);
	}
}
function makePetUI(rt) {
	const { h, useState, useEffect, useRef } = rt;
	injectCss$1();
	/** 余额气泡（哑组件：数据与显隐由 PetCard 传入） */
	const BalanceBubble = makeBalanceBubble({ h });
	/** 碎碎念气泡（哑组件：文本与显隐由 PetCard 传入） */
	const WhisperBubble = makeWhisperBubble({ h });
	/** 单个宠物实例（配置由容器 PetMulti 传入；碎碎念轮询/触发/气泡完全自理） */
	function PetCard({ cfg, balance, balanceTick, balanceNoticeTick, balanceManual, workStatus, workStatusTick, say, sayTick, animCue, animCueTick, arena }) {
		const [size, setSize] = useState(cfg.size);
		const fontPx = resolveFontPx(cfg.font, size);
		const halfW = size / 2;
		const halfH = size * 9 / 16 / 2;
		const bottomPad = size * (9 / 16) * (CANVAS_H - FEET_Y) / CANVAS_H;
		const petAnims = cfg.animations;
		const petWeights = cfg.animationWeights;
		const [anim, setAnim] = useState(petAnims.idle[0] ?? "");
		const [once, setOnce] = useState(true);
		const [facing, setFacing] = useState("left");
		const [dragging, setDragging] = useState(false);
		const [tipOn, setTipOn] = useState(false);
		const tipRef = useRef(null);
		const [customPos, setCustomPos] = useState(null);
		const [corner, setCorner] = useState(cfg.position.corner);
		const [margin, setMargin] = useState({
			x: cfg.position.marginX,
			y: cfg.position.marginY
		});
		const [bubbleOn, setBubbleOn] = useState(false);
		const bubbleTimerRef = useRef(null);
		const [whisperBubbleOn, setWhisperBubbleOn] = useState(false);
		const whisperBubbleTimerRef = useRef(null);
		const [whisperText, setWhisperText] = useState(null);
		const [whisperImage, setWhisperImage] = useState(void 0);
		const [workBubbleOn, setWorkBubbleOn] = useState(false);
		const workBubbleTimerRef = useRef(null);
		const [workText, setWorkText] = useState(null);
		const menuRef = useRef(null);
		const chatRef = useRef(null);
		useEffect(() => {
			setSize(cfg.size);
			setCorner(cfg.position.corner);
			setMargin({
				x: cfg.position.marginX,
				y: cfg.position.marginY
			});
		}, [
			cfg.size,
			cfg.position.corner,
			cfg.position.marginX,
			cfg.position.marginY
		]);
		const [seq, setSeq] = useState(0);
		const rootRef = useRef(null);
		const stageRef = useRef(null);
		const videoARef = useRef(null);
		const videoBRef = useRef(null);
		const frontRef = useRef(0);
		const pendingRef = useRef(null);
		const genRef = useRef(0);
		const dragRef = useRef({
			active: false,
			dragging: false,
			sx: 0,
			sy: 0,
			offX: 0,
			offY: 0,
			lpTimer: null
		});
		const justDraggedRef = useRef(false);
		const dragTrailRef = useRef([]);
		const boxPxRef = useRef(null);
		const dragTargetRef = useRef(null);
		const dragVelRef = useRef({
			vx: 0,
			vy: 0
		});
		const dragFollowRef = useRef(null);
		const dragFollowTokenRef = useRef(0);
		const throwRef = useRef(null);
		const throwTokenRef = useRef(0);
		const throwStateRef = useRef(null);
		const pressScoreFiredRef = useRef(false);
		const squashRef = useRef(null);
		const squashTokenRef = useRef(0);
		const pendingSquashRef = useRef(false);
		const animRef = useRef(anim);
		animRef.current = anim;
		const workStatusRef = useRef(workStatus);
		workStatusRef.current = workStatus;
		const blobUrlRef = useRef({
			a: null,
			b: null
		});
		const mountedRef = useRef(false);
		const inflightRef = useRef([]);
		const switchTo = (next, nextOnce) => {
			if (!next) return;
			const pending = pendingRef.current;
			if (pending && pending.anim === next && pending.once === nextOnce) {
				if (pendingSquashRef.current) {
					pendingSquashRef.current = false;
					const front = frontRef.current === 0 ? videoARef : videoBRef;
					if (front.current) startSquash(front.current);
				}
				return;
			}
			const gen = ++genRef.current;
			pendingRef.current = {
				anim: next,
				once: nextOnce,
				gen
			};
			const target = frontRef.current === 0 ? videoBRef : videoARef;
			const el = target.current;
			if (!el) return;
			const inEvents = isEventAnim(petAnims.events, next);
			if (inEvents) console.log("[dsh-whale-girl] " + new Date().toTimeString().slice(0, 8) + " pet=" + cfg.id + " switch " + next + " once=" + nextOnce);
			const assetUrl = "/dsh-whale-girl/thumb/" + encodeURIComponent(cfg.assetRoot ?? cfg.id) + "/" + encodeURIComponent(next) + THUMB_EXT;
			el.loop = !nextOnce;
			el.muted = true;
			el.autoplay = true;
			el.playsInline = true;
			el.onended = nextOnce ? handleEnded : null;
			const targetIsB = frontRef.current === 0;
			const ac = new AbortController();
			inflightRef.current.push(ac);
			const fetchTimer = window.setTimeout(() => ac.abort(), 1e4);
			fetch(assetUrl, {
				cache: "default",
				signal: ac.signal
			}).then((r) => {
				if (!r.ok) throw new Error("asset HTTP " + r.status);
				return r.blob();
			}).then((blob) => {
				window.clearTimeout(fetchTimer);
				const ix = inflightRef.current.indexOf(ac);
				if (ix !== -1) inflightRef.current.splice(ix, 1);
				if (!mountedRef.current) return;
				if (pendingRef.current?.gen !== gen) return;
				const slot = targetIsB ? "b" : "a";
				const oldUrl = blobUrlRef.current[slot];
				if (oldUrl) URL.revokeObjectURL(oldUrl);
				const obj = URL.createObjectURL(blob);
				blobUrlRef.current[slot] = obj;
				el.src = obj;
				el.load();
			}).catch((err) => {
				window.clearTimeout(fetchTimer);
				const ix = inflightRef.current.indexOf(ac);
				if (ix !== -1) inflightRef.current.splice(ix, 1);
				if (!mountedRef.current) return;
				if (pendingRef.current?.gen !== gen) return;
				pendingRef.current = null;
				console.warn("[dsh-whale-girl] 素材加载失败 pet=" + cfg.id + " anim=" + next + "：" + (err instanceof Error ? err.message : String(err)) + "（已释放本次切换）");
			});
			const onReady = () => {
				el.removeEventListener("loadeddata", onReady);
				if (pendingRef.current?.gen !== gen) return;
				const old = frontRef.current === 0 ? videoARef : videoBRef;
				el.classList.add("is-front");
				if (old.current && old.current !== el) {
					old.current.classList.remove("is-front");
					old.current.onended = null;
					old.current.pause();
				}
				frontRef.current = frontRef.current === 0 ? 1 : 0;
				pendingRef.current = null;
				el.style.transform = facingRef.current === "right" ? "scaleX(-1)" : "";
				el.play().catch(() => {});
				if (pendingSquashRef.current) {
					pendingSquashRef.current = false;
					startSquash(el);
				}
				if (pendingMoveRef.current) startMoveDrive(el);
			};
			el.addEventListener("loadeddata", onReady);
		};
		useEffect(() => {
			switchTo(anim, once);
		}, [
			anim,
			once,
			seq
		]);
		useEffect(() => {
			mountedRef.current = true;
			const bu = blobUrlRef.current;
			const inflight = inflightRef.current;
			return () => {
				mountedRef.current = false;
				for (const c of inflight) c.abort();
				inflight.length = 0;
				stopMove();
				stopDragFollow();
				stopThrow();
				stopSquash();
				if (bu.a) URL.revokeObjectURL(bu.a);
				if (bu.b) URL.revokeObjectURL(bu.b);
			};
		}, []);
		useEffect(() => () => {
			if (bubbleTimerRef.current !== null) window.clearTimeout(bubbleTimerRef.current);
			if (whisperBubbleTimerRef.current !== null) window.clearTimeout(whisperBubbleTimerRef.current);
		}, []);
		useEffect(() => () => {
			if (menuRef.current) {
				menuRef.current.close();
				menuRef.current = null;
			}
			if (chatRef.current) {
				chatRef.current.close();
				chatRef.current = null;
			}
		}, []);
		const prevTickRef = useRef(0);
		useEffect(() => {
			if (balanceTick === 0 || balanceTick === prevTickRef.current) return;
			prevTickRef.current = balanceTick;
			if (!balance || !balance.ok) return;
			if (!cfg.balanceEnabled && !balanceManual) return;
			const p = balancePercent(balance);
			if (balanceManual || p !== void 0) {
				setBubbleOn(true);
				if (bubbleTimerRef.current !== null) window.clearTimeout(bubbleTimerRef.current);
				bubbleTimerRef.current = window.setTimeout(() => setBubbleOn(false), BUBBLE_DURATION_MS);
			}
			if (!cfg.balanceEnabled) return;
			if (p === void 0) return;
			const pool = petAnims.events?.balance;
			if (!pool || pool.length === 0) {
				console.error("[dsh-whale-girl] 配置缺少 animations.events.balance，无法播放余额事件动画");
				return;
			}
			const idx = balanceEventIndex(p);
			const slot = pool[idx];
			if (!slot) {
				console.error("[dsh-whale-girl] balance 档位索引越界：p=" + p + " idx=" + idx);
				return;
			}
			const name = pickSlot(slot, animRef.current);
			console.log("[dsh-whale-girl] " + new Date().toTimeString().slice(0, 8) + " balance pet=" + cfg.id + " p=" + p.toFixed(1) + "% -> [档" + idx + "] " + name);
			stopMove();
			setOnce(true);
			setAnim(name);
		}, [balanceTick]);
		const prevNoticeRef = useRef(0);
		useEffect(() => {
			if (!cfg.balanceEnabled && !balanceManual) return;
			if (balanceNoticeTick === 0 || balanceNoticeTick === prevNoticeRef.current) return;
			prevNoticeRef.current = balanceNoticeTick;
			if (!balance || balance.ok) return;
			setBubbleOn(true);
			if (bubbleTimerRef.current !== null) window.clearTimeout(bubbleTimerRef.current);
			bubbleTimerRef.current = window.setTimeout(() => setBubbleOn(false), BUBBLE_DURATION_MS);
		}, [balanceNoticeTick]);
		const prevWorkTickRef = useRef(0);
		const prevWorkStateRef = useRef(void 0);
		useEffect(() => {
			if (!cfg.workStatusEnabled) return;
			if (workStatusTick === 0 || workStatusTick === prevWorkTickRef.current) return;
			prevWorkTickRef.current = workStatusTick;
			if (!workStatus || workStatus.state === null) {
				console.log("[dsh-whale-girl] " + new Date().toTimeString().slice(0, 8) + " pet=" + cfg.id + " " + (prevWorkStateRef.current ?? "null") + "->null    播完即停（回待机，收起气泡）");
				prevWorkStateRef.current = null;
				if (poolIncludes(petAnims.events?.workStatus ?? [], animRef.current)) {
					const front = frontRef.current === 0 ? videoARef.current : videoBRef.current;
					if (front) {
						front.loop = false;
						front.onended = handleEnded;
					}
				}
				if (workBubbleTimerRef.current !== null) window.clearTimeout(workBubbleTimerRef.current);
				workBubbleTimerRef.current = null;
				setWorkText(null);
				setWorkBubbleOn(false);
				return;
			}
			const pool = petAnims.events?.workStatus;
			if (!pool || pool.length === 0) {
				console.error("[dsh-whale-girl] 配置缺少 animations.events.workStatus，无法播放工作状态动画");
				return;
			}
			const idx = WORK_STATUS_INDEX[workStatus.state];
			const slot = pool[idx];
			if (slot === void 0) {
				console.error("[dsh-whale-girl] work-status 档位索引越界：state=" + workStatus.state + " idx=" + idx);
				return;
			}
			const name = pickSlot(slot, animRef.current);
			console.log("[dsh-whale-girl] " + new Date().toTimeString().slice(0, 8) + " pet=" + cfg.id + " " + (prevWorkStateRef.current ?? "null") + "->" + workStatus.state + "    " + name);
			const stateChanged = prevWorkStateRef.current !== workStatus.state;
			prevWorkStateRef.current = workStatus.state;
			stopMove();
			const textGroup = Array.isArray(cfg.workStatusTexts) ? cfg.workStatusTexts[idx] : void 0;
			const configuredText = Array.isArray(textGroup) && textGroup.length > 0 ? textGroup[Math.floor(Math.random() * textGroup.length)] : void 0;
			setWorkText(workStatus.task ?? configuredText ?? null);
			const terminal = workStatus.state === "success" || workStatus.state === "error";
			if (stateChanged) {
				setWorkBubbleOn(true);
				if (workBubbleTimerRef.current !== null) window.clearTimeout(workBubbleTimerRef.current);
				workBubbleTimerRef.current = terminal ? window.setTimeout(() => setWorkBubbleOn(false), BUBBLE_DURATION_MS) : null;
			}
			const rotating = !terminal && Array.isArray(slot) && slot.length > 1;
			setOnce(terminal || rotating);
			setAnim(name);
		}, [workStatusTick]);
		const prevSaySeqRef = useRef(0);
		useEffect(() => {
			if (!say || say.seq === prevSaySeqRef.current) return;
			prevSaySeqRef.current = say.seq;
			triggerWhisper(say.text, say.image);
		}, [sayTick]);
		const prevAnimSeqRef = useRef(0);
		useEffect(() => {
			if (!animCue || animCue.seq === prevAnimSeqRef.current) return;
			prevAnimSeqRef.current = animCue.seq;
			handleMenuAction({
				label: animCue.name,
				anim: animCue.name
			});
		}, [animCueTick]);
		const triggerWhisper = (text, image) => {
			const pool = petAnims.events?.whisper;
			if (!pool || pool.length === 0) {
				console.error("[dsh-whale-girl] 配置缺少 animations.events.whisper，无法播放碎碎念动画");
				return;
			}
			const name = pickSlot(pick(pool, animRef.current), animRef.current);
			console.log("[dsh-whale-girl] " + new Date().toTimeString().slice(0, 8) + " whisper pet=" + cfg.id + " -> [" + name + "] 「" + text + "」");
			stopMove();
			setWhisperText(text);
			setWhisperImage(image);
			setWhisperBubbleOn(true);
			if (whisperBubbleTimerRef.current !== null) window.clearTimeout(whisperBubbleTimerRef.current);
			whisperBubbleTimerRef.current = window.setTimeout(() => setWhisperBubbleOn(false), BUBBLE_DURATION_MS);
			setOnce(true);
			setAnim(name);
		};
		useEffect(() => {
			const onResize = () => setCustomPos((prev) => prev ? { ...prev } : prev);
			window.addEventListener("resize", onResize);
			return () => window.removeEventListener("resize", onResize);
		}, []);
		const pickNext = () => {
			const animations = petAnims;
			const animationWeights = petWeights;
			const roll = Math.random();
			const k = rollKind(roll, animationWeights, { fixed: cfg.fixedEnabled });
			let kind;
			let next;
			if (k === "idle") {
				kind = "IDLE";
				next = pick(animations.idle, animRef.current);
				setAnim(next);
			} else if (k === "turn") {
				kind = "TURN";
				next = pick(animations.turn, animRef.current);
				setAnim(next);
			} else if (k === "move") {
				const moved = tryMove();
				if (moved === false) {
					const act = pickCategoryAction(animations.categories, animations.idle, facingRef.current, animRef.current);
					kind = act.id;
					next = act.name;
					setAnim(next);
				} else {
					kind = "MOVES";
					next = typeof moved === "string" ? moved : "移动进行中(不重播)";
				}
			} else {
				const act = pickCategoryAction(animations.categories, animations.idle, facingRef.current, animRef.current);
				kind = act.id;
				next = act.name;
				setAnim(next);
			}
			console.log("[dsh-whale-girl] " + new Date().toTimeString().slice(0, 8) + " pet=" + cfg.id + " facing=" + facingRef.current + " roll=" + roll.toFixed(4) + " -> [" + kind + "] " + next);
			setOnce(true);
			setSeq((s) => s + 1);
		};
		const resumeWorkStatusAnim = () => {
			const ws = workStatusRef.current;
			if (!ws || !ws.state || ws.state === "success" || ws.state === "error") return false;
			const pool = petAnims.events?.workStatus;
			if (!pool || pool.length === 0) return false;
			const idx = WORK_STATUS_INDEX[ws.state];
			const slot = pool[idx];
			if (slot === void 0) return false;
			const name = pickSlot(slot, animRef.current);
			console.log("[dsh-whale-girl] " + new Date().toTimeString().slice(0, 8) + " pet=" + cfg.id + " 互动结束恢复状态动画: " + name);
			setOnce(Array.isArray(slot) && slot.length > 1);
			setAnim(name);
			return true;
		};
		const handleEnded = (e) => {
			const evEl = e && e.currentTarget;
			if (evEl && !evEl.classList.contains("is-front")) return;
			const animations = petAnims;
			if (dragRef.current.active) return;
			const isEvent = isEventAnim(animations.events, animRef.current);
			const wsNow = workStatusRef.current;
			if (isEvent && wsNow && wsNow.state && wsNow.state !== "success" && wsNow.state !== "error") {
				const nextWork = nextWorkStatusAnim(animations.events?.workStatus ?? [], animRef.current);
				if (nextWork !== null) {
					console.log("[dsh-whale-girl] " + new Date().toTimeString().slice(0, 8) + " pet=" + cfg.id + " workStatus 档内轮换: " + animRef.current + " -> " + nextWork);
					setOnce(true);
					setAnim(nextWork);
					setSeq((s) => s + 1);
					return;
				}
				if (poolIncludes(animations.events?.workStatus ?? [], animRef.current)) {
					console.log("[dsh-whale-girl] " + new Date().toTimeString().slice(0, 8) + " pet=" + cfg.id + " workStatus 循环续播: " + animRef.current);
					setOnce(false);
					setSeq((s) => s + 1);
					return;
				}
			}
			if (isEvent) {
				console.log("[dsh-whale-girl] " + new Date().toTimeString().slice(0, 8) + " pet=" + cfg.id + " 事件动画播完 ended anim=" + animRef.current + " ws=" + (workStatusRef.current && workStatusRef.current.state || "null"));
				if (resumeWorkStatusAnim()) return;
				if (animations.idle.length) setAnim(pick(animations.idle, animRef.current));
				setOnce(true);
				setSeq((s) => s + 1);
				return;
			}
			if (animations.turn.includes(animRef.current)) {
				const next = facing === "left" ? "right" : "left";
				setFacing(next);
				facingRef.current = next;
			}
			if (animations.drag.includes(animRef.current) || animations.clicks.includes(animRef.current)) {
				if (resumeWorkStatusAnim()) return;
				if (animations.idle.length) setAnim(pick(animations.idle, animRef.current));
				setOnce(true);
				setSeq((s) => s + 1);
				return;
			}
			pickNext();
		};
		const moveRef = useRef(null);
		const moveTokenRef = useRef(0);
		const pendingMoveRef = useRef(null);
		const customPosRef = useRef(customPos);
		customPosRef.current = customPos;
		const currentCenterX = () => {
			const cp = customPosRef.current;
			if (cp) return cp.rx * window.innerWidth;
			const rootEl = rootRef.current;
			if (rootEl) return rootEl.getBoundingClientRect().left + halfW;
			return window.innerWidth - 24 - halfW;
		};
		const currentCenterY = () => {
			const cp = customPosRef.current;
			if (cp) return cp.ry * window.innerHeight;
			const rootEl = rootRef.current;
			if (rootEl) return rootEl.getBoundingClientRect().top + halfH;
			return window.innerHeight - 20 - halfH;
		};
		const startMoveDrive = (el) => {
			const pm = pendingMoveRef.current;
			if (!pm || moveRef.current !== null) return;
			pendingMoveRef.current = null;
			const { startRatio, startYRatio, targetRatio, dir, totalRatio, leadSec, tailSec } = pm;
			const duration = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 10.09;
			const travelWindow = Math.max(.1, duration - leadSec - tailSec);
			const token = ++moveTokenRef.current;
			const step = () => {
				if (moveTokenRef.current !== token) return;
				const t = el.currentTime || 0;
				const rootEl = rootRef.current;
				if (rootEl) {
					const W = window.innerWidth;
					const H = window.innerHeight;
					let ratioX;
					if (t <= leadSec) ratioX = startRatio;
					else if (t >= duration - tailSec) ratioX = targetRatio;
					else ratioX = startRatio + dir * totalRatio * ((t - leadSec) / travelWindow);
					const px = ratioX * W;
					const py = startYRatio * H;
					rootEl.style.left = px - halfW + "px";
					rootEl.style.top = py - halfH + "px";
					rootEl.style.right = "auto";
					rootEl.style.bottom = "auto";
				}
				if (t < duration - tailSec) moveRef.current = requestAnimationFrame(step);
				else {
					moveRef.current = null;
					setCustomPos({
						rx: targetRatio,
						ry: startYRatio
					});
				}
			};
			moveRef.current = requestAnimationFrame(step);
		};
		/** 尝试发起一次移动：占用中返回 true（不重播），无法移动返回 false，成功返回动作名（供日志显示具体动作）。
		
		*  preferredName 传入时固定使用该动画（右键菜单点播移动动画），否则与随机链一致随机从 moves.actions 选。 */
		const tryMove = (preferredName) => {
			if (moveRef.current !== null || pendingMoveRef.current || throwRef.current !== null) return true;
			const moves = petAnims.moves;
			const actions = moves.actions;
			if (!actions.length) return false;
			const chosen = preferredName ? actions.find((a) => a.name === preferredName) ?? null : actions[Math.floor(Math.random() * actions.length)];
			if (!chosen) return false;
			const mp = Object.assign({}, moves.default, chosen.params || {});
			const dir = facingRef.current === "right" !== petAnims.turn.includes(animRef.current) ? 1 : -1;
			const W = window.innerWidth;
			const distScale = size / PET_REF_WIDTH;
			const plan = planMove({
				cx: currentCenterX(),
				cy: currentCenterY(),
				W,
				H: window.innerHeight,
				dir,
				minDist: mp.minDist * distScale,
				maxDist: mp.maxDist * distScale,
				margin: mp.margin,
				halfW,
				sideAllow
			});
			if (!plan) return false;
			pendingMoveRef.current = {
				...plan,
				dir,
				leadSec: mp.leadSec,
				tailSec: mp.tailSec
			};
			setOnce(true);
			setAnim(chosen.name);
			return chosen.name;
		};
		const stopMove = () => {
			pendingMoveRef.current = null;
			moveTokenRef.current++;
			if (moveRef.current !== null) {
				cancelAnimationFrame(moveRef.current);
				moveRef.current = null;
			}
		};
		/** 停止弹簧跟随（不碰 dragState：指针捕获期间由 pointerdown/up 独立管理） */
		const stopDragFollow = () => {
			dragFollowTokenRef.current++;
			if (dragFollowRef.current !== null) {
				cancelAnimationFrame(dragFollowRef.current);
				dragFollowRef.current = null;
			}
			dragTargetRef.current = null;
			dragVelRef.current = {
				vx: 0,
				vy: 0
			};
		};
		/** 停止抛掷（宠物在空中被抓住/点菜单/回家时立即定格在当前落点）。
		
		*  同时清速度状态 throwStateRef——否则「抓住后温柔放下」会残留最后一次飞行速度，
		
		*  静止的宠物点一下就误判为飞行中。点击积分用的飞行动态由 pointerdown 提前记录。 */
		const stopThrow = () => {
			throwTokenRef.current++;
			if (throwRef.current !== null) {
				cancelAnimationFrame(throwRef.current);
				throwRef.current = null;
			}
			throwStateRef.current = null;
		};
		/** rAF 弹簧跟随：包围盒朝拖拽目标（指针-抓取偏移）过阻尼追赶，抹平高频抖动 */
		const startDragFollow = (rootEl) => {
			if (dragFollowRef.current !== null) return;
			const token = ++dragFollowTokenRef.current;
			let last = performance.now();
			const step = () => {
				if (dragFollowTokenRef.current !== token) return;
				const target = dragTargetRef.current;
				if (!target) {
					dragFollowRef.current = null;
					return;
				}
				const now = performance.now();
				const dt = Math.min((now - last) / 1e3, 1 / 30);
				last = now;
				const vel = dragVelRef.current;
				let x = boxPxRef.current?.x ?? 0;
				let y = boxPxRef.current?.y ?? 0;
				vel.vx = springStep(vel.vx, x, target.x, dt, cfg.physics.throwPower);
				vel.vy = springStep(vel.vy, y, target.y, dt, cfg.physics.throwPower);
				x += vel.vx * dt;
				y += vel.vy * dt;
				boxPxRef.current = {
					x,
					y
				};
				rootEl.style.left = x + "px";
				rootEl.style.top = y + "px";
				rootEl.style.right = "auto";
				rootEl.style.bottom = "auto";
				dragFollowRef.current = requestAnimationFrame(step);
			};
			dragFollowRef.current = requestAnimationFrame(step);
		};
		/** 抛掷驱动：重力 + 边缘反弹 + 落地摩擦，落定后提交 customPos（飞行中只改 DOM，避免逐帧 React 重渲染） */
		const startThrow = (px, py, vx, vy) => {
			stopDragFollow();
			stopMove();
			const bounds = throwBounds({
				W: window.innerWidth,
				H: window.innerHeight,
				size,
				sideAllow
			});
			const token = ++throwTokenRef.current;
			let state = {
				x: px,
				y: py,
				vx,
				vy
			};
			let last = performance.now();
			let prevGrounded = false;
			const rootEl = rootRef.current;
			const step = () => {
				if (throwTokenRef.current !== token) return;
				const now = performance.now();
				const dt = (now - last) / 1e3;
				last = now;
				const fallingVy = state.vy;
				const res = throwStep(state, dt, bounds, cfg.physics);
				state = {
					x: res.x,
					y: res.y,
					vx: res.vx,
					vy: res.vy
				};
				throwStateRef.current = state;
				if (cfg.physics.petCollision) {
					const myBody = bodyPixelBox({
						x: state.x,
						y: state.y,
						size,
						bottomPad
					});
					for (const slotId of Object.keys(arena.current.slots)) {
						if (slotId === cfg.id) continue;
						const slot = arena.current.slots[slotId];
						const otherBox = slot.getBox();
						if (!otherBox) continue;
						const otherBody = bodyPixelBox({
							x: otherBox.x,
							y: otherBox.y,
							size: slot.size,
							bottomPad: slot.bottomPad
						});
						if (!rectsOverlap(myBody, otherBody)) continue;
						const vel = slot.getVel();
						const hit = collidePet({
							x: state.x,
							y: state.y,
							vx: state.vx,
							vy: state.vy,
							size
						}, {
							x: otherBox.x,
							y: otherBox.y,
							vx: vel.vx,
							vy: vel.vy,
							size: slot.size
						});
						if (hit) {
							state.vx = hit.fvx;
							state.vy = hit.fvy;
							throwStateRef.current = state;
							slot.onHit(hit.hvx, hit.hvy);
							break;
						}
					}
				}
				if (rootEl) {
					rootEl.style.left = res.x + "px";
					rootEl.style.top = res.y + "px";
					rootEl.style.right = "auto";
					rootEl.style.bottom = "auto";
				}
				boxPxRef.current = {
					x: res.x,
					y: res.y
				};
				customPosRef.current = {
					rx: (res.x + halfW) / window.innerWidth,
					ry: (res.y + halfH) / window.innerHeight
				};
				const grounded = res.y >= bounds.maxY - 1;
				if (res.bounced && grounded && !prevGrounded) {
					const frontEl = frontRef.current === 0 ? videoARef.current : videoBRef.current;
					if (frontEl) startSquash(frontEl, landingSquash(fallingVy));
				}
				prevGrounded = grounded;
				if (res.atRest) {
					throwRef.current = null;
					throwStateRef.current = null;
					setCustomPos(customPosRef.current);
					return;
				}
				throwRef.current = requestAnimationFrame(step);
			};
			throwRef.current = requestAnimationFrame(step);
		};
		/** 被撞回调（宠物间碰撞）：被其它飞行中宠物撞到 → 停当前动作，从落点以新初速抛出去（全复用现有物理） */
		const startThrowLatestRef = useRef(() => {});
		startThrowLatestRef.current = startThrow;
		const onPetHit = (vx, vy) => {
			stopMove();
			stopDragFollow();
			stopThrow();
			const bx = boxPxRef.current;
			let sx = 0;
			let sy = 0;
			if (bx) {
				sx = bx.x;
				sy = bx.y;
			} else {
				const r = rootRef.current?.getBoundingClientRect();
				if (r) {
					sx = r.left;
					sy = r.top;
				}
			}
			startThrowLatestRef.current(sx, sy, vx, vy);
		};
		useEffect(() => {
			const arenaSlots = arena.current.slots;
			arenaSlots[cfg.id] = {
				size,
				bottomPad,
				getBox: () => {
					if (boxPxRef.current) return boxPxRef.current;
					const r = rootRef.current?.getBoundingClientRect();
					return r ? {
						x: r.left,
						y: r.top
					} : null;
				},
				getVel: () => throwRef.current !== null && throwStateRef.current ? {
					vx: throwStateRef.current.vx,
					vy: throwStateRef.current.vy
				} : {
					vx: 0,
					vy: 0
				},
				onHit: onPetHit
			};
			return () => {
				delete arenaSlots[cfg.id];
			};
		}, [
			cfg.id,
			size,
			bottomPad,
			arena
		]);
		/** Q 弹挤压：前台视频垂直压扁（贴地锚定，transform-origin:bottom）再回弹；
		
		*  与桌面同构，曲线在 shared（squashScale）。depth = 下压幅度（点击固定 0.55；
		
		*  落地按冲击速度 landingSquash 动态取）。reduce-motion 时跳过。 */
		const startSquash = (el, depth = SQ_SQUASH) => {
			if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
			const token = ++squashTokenRef.current;
			if (squashRef.current !== null) cancelAnimationFrame(squashRef.current);
			const origin = el.style.transformOrigin;
			el.style.transformOrigin = "bottom";
			const t0 = performance.now();
			const step = () => {
				if (squashTokenRef.current !== token) return;
				const u = Math.min((performance.now() - t0) / SQ_DURATION_MS, 1);
				const scale = squashScale(u, depth);
				el.style.transform = (facingRef.current === "right" ? "scaleX(-1) " : "") + "scaleY(" + scale + ")";
				if (u < 1) squashRef.current = requestAnimationFrame(step);
				else {
					squashRef.current = null;
					el.style.transformOrigin = origin;
					el.style.transform = facingRef.current === "right" ? "scaleX(-1)" : "";
				}
			};
			squashRef.current = requestAnimationFrame(step);
		};
		const stopSquash = () => {
			squashTokenRef.current++;
			if (squashRef.current !== null) {
				cancelAnimationFrame(squashRef.current);
				squashRef.current = null;
			}
		};
		const facingRef = useRef(facing);
		facingRef.current = facing;
		/** 把提示框摆到光标右下（右边/下边装不下自动翻边并夹回视口内）。
		
		*  直接写 DOM style 而不走 React 状态：鼠标每动一下都更新状态会让整个 PetCard 重渲染，
		
		*  代价远大于这一次样式写入（root 的位置也是这么直接写的）。
		
		*  bounds 用视口——提示是 position:fixed，坐标就是 clientX/clientY 这一套。 */
		const placeTip = (clientX, clientY) => {
			const tipEl = tipRef.current;
			if (!tipEl) return;
			const viewport = document.documentElement;
			const p = tooltipPlacement({
				x: clientX,
				y: clientY
			}, {
				w: tipEl.offsetWidth,
				h: tipEl.offsetHeight
			}, {
				x: 0,
				y: 0,
				w: viewport.clientWidth,
				h: viewport.clientHeight
			}, size * TOOLTIP_GAP_RATIO);
			tipEl.style.left = p.x + "px";
			tipEl.style.top = p.y + "px";
		};
		const handlePointerDown = (e) => {
			if (e.button !== 0) return;
			const grabState = throwStateRef.current;
			console.log("[dsh-whale-girl] " + new Date().toTimeString().slice(0, 8) + " pet=" + cfg.id + " grab vx=" + (grabState ? Math.round(grabState.vx) : 0) + " vy=" + (grabState ? Math.round(grabState.vy) : 0) + " |v|=" + (grabState ? Math.round(Math.hypot(grabState.vx, grabState.vy)) : 0));
			pressScoreFiredRef.current = false;
			if (grabState) {
				const grabSpeed = Math.hypot(grabState.vx, grabState.vy);
				if (grabSpeed >= SCORE_MIN_SPEED) {
					const sc = clickScore(grabSpeed, size);
					pressScoreFiredRef.current = true;
					console.log("[dsh-whale-girl] " + new Date().toTimeString().slice(0, 8) + " pet=" + cfg.id + " click-score speed=" + Math.round(grabSpeed) + " size=" + size + " -> +" + sc);
					spawnScoreBurst(e.clientX, e.clientY);
					mountScorePopup({
						x: e.clientX,
						y: e.clientY,
						score: sc,
						speed: grabSpeed,
						size
					});
				}
			}
			stopThrow();
			stopDragFollow();
			stopMove();
			dragTrailRef.current = [];
			e.currentTarget.classList.add("dragging");
			e.currentTarget.setPointerCapture(e.pointerId);
			setTipOn(false);
			const rootEl = rootRef.current;
			let offX = 0;
			let offY = 0;
			if (rootEl) {
				const rr = rootEl.getBoundingClientRect();
				offX = e.clientX - (rr.left + rr.width / 2);
				offY = e.clientY - (rr.top + rr.height / 2);
				boxPxRef.current = {
					x: rr.left,
					y: rr.top
				};
			}
			dragRef.current = {
				active: true,
				dragging: false,
				sx: e.clientX,
				sy: e.clientY,
				offX,
				offY,
				lpTimer: null
			};
			if (e.pointerType !== "mouse" && e.pointerType !== "pen") {
				const lpEl = e.currentTarget;
				const lpId = e.pointerId;
				const lpX = e.clientX;
				const lpY = e.clientY;
				dragRef.current.lpTimer = setTimeout(() => {
					dragRef.current.lpTimer = null;
					const dl = dragRef.current;
					if (!dl.active || dl.dragging) return;
					dl.active = false;
					pressScoreFiredRef.current = true;
					if (lpEl.hasPointerCapture(lpId)) lpEl.releasePointerCapture(lpId);
					console.log("[dsh-whale-girl] " + new Date().toTimeString().slice(0, 8) + " pet=" + cfg.id + " -> [TOUCH-MENU]");
					lpEl.dispatchEvent(new MouseEvent("contextmenu", {
						bubbles: true,
						cancelable: true,
						view: window,
						clientX: lpX,
						clientY: lpY,
						button: 2
					}));
				}, 500);
			}
		};
		const handlePointerMove = (e) => {
			if (tipOn) placeTip(e.clientX, e.clientY);
			const d = dragRef.current;
			if (!d.active) return;
			const dx = e.clientX - d.sx;
			const dy = e.clientY - d.sy;
			if (d.lpTimer && Math.hypot(dx, dy) > 8) {
				clearTimeout(d.lpTimer);
				d.lpTimer = null;
			}
			if (!d.dragging) {
				if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
				d.dragging = true;
				setDragging(true);
				setOnce(true);
				if (petAnims.drag.length) {
					const name = pick(petAnims.drag);
					console.log("[dsh-whale-girl] " + new Date().toTimeString().slice(0, 8) + " pet=" + cfg.id + " -> [DRAG] " + name);
					setAnim(name);
				}
			}
			const now = performance.now();
			dragTrailRef.current = trimTrail([...dragTrailRef.current, {
				t: now,
				x: e.clientX,
				y: e.clientY
			}], now);
			dragTargetRef.current = {
				x: e.clientX - d.offX - halfW,
				y: e.clientY - d.offY - halfH
			};
			const rootEl = rootRef.current;
			if (rootEl) startDragFollow(rootEl);
			const stageEl = stageRef.current;
			if (stageEl) stageEl.style.transform = "none";
		};
		const handlePointerUp = (e) => {
			const d = dragRef.current;
			if (d.lpTimer) {
				clearTimeout(d.lpTimer);
				d.lpTimer = null;
			}
			const wasDragging = d.dragging;
			d.active = false;
			d.dragging = false;
			e.currentTarget.classList.remove("dragging");
			stopDragFollow();
			if (wasDragging) {
				justDraggedRef.current = true;
				setTimeout(() => {
					justDraggedRef.current = false;
				}, 100);
				setDragging(false);
				const stageEl = stageRef.current;
				if (stageEl) stageEl.style.transform = "translateY(" + bottomPad + "px)";
				if (!resumeWorkStatusAnim()) {
					if (petAnims.idle.length) setAnim(pick(petAnims.idle, animRef.current));
					setOnce(true);
				}
				const bx = boxPxRef.current;
				const px = bx ? bx.x : e.clientX - d.offX - halfW;
				const py = bx ? bx.y : e.clientY - d.offY - halfH;
				const vel = estimateReleaseVelocity(dragTrailRef.current, performance.now(), cfg.physics);
				dragTrailRef.current = [];
				if (vel) {
					console.log("[dsh-whale-girl] " + new Date().toTimeString().slice(0, 8) + " pet=" + cfg.id + " release vx=" + Math.round(vel.vx) + " vy=" + Math.round(vel.vy) + " |v|=" + Math.round(Math.hypot(vel.vx, vel.vy)));
					startThrow(px, py, vel.vx, vel.vy);
				} else setCustomPos({
					rx: (px + halfW) / window.innerWidth,
					ry: (py + halfH) / window.innerHeight
				});
			}
			const hitRect = e.currentTarget.getBoundingClientRect();
			if (e.clientX >= hitRect.left && e.clientX <= hitRect.right && e.clientY >= hitRect.top && e.clientY <= hitRect.bottom) {
				placeTip(e.clientX, e.clientY);
				setTipOn(true);
			}
		};
		const handleClick = () => {
			const d = dragRef.current;
			if (d.active || d.dragging || justDraggedRef.current) return;
			if (pressScoreFiredRef.current) {
				pressScoreFiredRef.current = false;
				stopThrow();
				stopMove();
				return;
			}
			stopThrow();
			stopMove();
			setOnce(true);
			if (!petAnims.clicks.length) return;
			const name = pick(petAnims.clicks);
			console.log("[dsh-whale-girl] " + new Date().toTimeString().slice(0, 8) + " pet=" + cfg.id + " -> [CLICK] " + name);
			pendingSquashRef.current = true;
			setSeq((s) => s + 1);
			setAnim(name);
		};
		const handleMenuAction = (leaf$1) => {
			if (leaf$1.action === "toggle-sight") {
				postAction("/dsh-whale-girl/sight/toggle").catch(() => {});
				return;
			}
			if (leaf$1.action === "toggle-autoplay") {
				postAction("/dsh-whale-girl/autoplay/toggle").catch(() => {});
				return;
			}
			if (leaf$1.action === "show-balance") {
				console.info("[dsh-whale-girl] 菜单查看余额 pet=" + cfg.id);
				postAction("/dsh-whale-girl/balance").then((ok) => {
					if (!ok) console.warn("[dsh-whale-girl] 余额刷新动作未成功 pet=" + cfg.id);
					statePoller.now();
				}).catch((e) => console.warn("[dsh-whale-girl] 余额刷新异常", e));
				return;
			}
			if (leaf$1.action === "whisper") {
				console.info("[dsh-whale-girl] 菜单触发碎碎念 pet=" + cfg.id);
				postAction("/dsh-whale-girl/whisper?pet=" + encodeURIComponent(cfg.id)).then((ok) => {
					if (!ok) console.warn("[dsh-whale-girl] 碎碎念手动触发失败 pet=" + cfg.id);
					statePoller.now();
				}).catch((e) => console.warn("[dsh-whale-girl] 碎碎念手动触发异常", e));
				return;
			}
			if (leaf$1.action === "chat") {
				if (chatRef.current) chatRef.current.close();
				const hitRect = stageRef.current?.querySelector(".dsh-whale-girl-hit")?.getBoundingClientRect();
				chatRef.current = mountChatDialog({
					petId: cfg.id,
					baseUrl: "/dsh-whale-girl/chat",
					x: hitRect ? hitRect.right + 6 : window.innerWidth - 256,
					y: hitRect ? hitRect.top + 6 : 8,
					onSent: () => {
						console.info("[dsh-whale-girl] 对话已发送 pet=" + cfg.id);
						statePoller.now();
					},
					onClose: () => {
						chatRef.current = null;
					}
				});
				return;
			}
			if (leaf$1.action === "set-display") {
				const display = leaf$1.display;
				if (!display) return;
				console.info("[dsh-whale-girl] 菜单切换显示位置 pet=" + cfg.id + " display=" + display);
				fetch("/dsh-whale-girl/pet-display", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						id: cfg.id,
						display
					})
				}).then(async (r) => {
					if (!r.ok) throw new Error("pet-display HTTP " + r.status);
					petBridge.reload(await r.json());
				}).catch((e) => console.warn("[dsh-whale-girl] 显示位置切换失败", e));
				return;
			}
			if (leaf$1.action === "home") {
				stopThrow();
				stopMove();
				setCustomPos(null);
				return;
			}
			if (!leaf$1.anim) return;
			if (isNoMirrorAnimation(petAnims.categories, leaf$1.anim) && facingRef.current === "right") setFacing("left");
			if (petAnims.moves.actions.some((a) => a.name === leaf$1.anim)) {
				if (tryMove(leaf$1.anim) === false) {
					stopMove();
					setOnce(true);
					setAnim(leaf$1.anim);
				}
				return;
			}
			stopMove();
			setOnce(true);
			setAnim(leaf$1.anim);
		};
		const handleContextMenu = (e) => {
			const tree = [
				{
					label: "查看余额",
					action: "show-balance"
				},
				{
					label: "碎碎念",
					action: "whisper"
				},
				{
					label: "对话",
					action: "chat"
				},
				{
					label: "开关：主动识屏",
					action: "toggle-sight"
				},
				{
					label: "开始 / 停止陪玩",
					action: "toggle-autoplay"
				},
				{
					label: "回到初始位置",
					action: "home"
				},
				displayMenuBranch(),
				...buildMenuTree(petAnims)
			];
			if (!tree.length) return;
			e.preventDefault();
			e.stopPropagation();
			const d = dragRef.current;
			if (d.active || d.dragging || justDraggedRef.current) return;
			stopThrow();
			stopMove();
			if (menuRef.current) menuRef.current.close();
			menuRef.current = mountContextMenu({
				tree,
				x: e.clientX,
				y: e.clientY,
				onAction: handleMenuAction,
				onClose: () => {
					if (menuRef.current) menuRef.current = null;
				}
			});
		};
		const sideAllow = HIT_BOX.x0 / 640 * size;
		const stageStyle = dragging ? { transform: "none" } : { transform: "translateY(" + bottomPad + "px)" };
		const rootStyle = customPos ? (() => {
			const rx = customPos.rx;
			const ry = customPos.ry;
			return {
				left: rx * window.innerWidth - halfW + "px",
				top: ry * window.innerHeight - halfH + "px",
				right: "auto",
				bottom: "auto"
			};
		})() : {};
		const workTerminal = workStatus?.state === "success" || workStatus?.state === "error";
		const bubbleNode = (() => {
			if (workTerminal && workBubbleOn && workText && cfg.workStatusEnabled) return h(WhisperBubble, {
				text: workText,
				on: workBubbleOn
			});
			if (whisperBubbleOn && whisperText) return h(WhisperBubble, {
				text: whisperText,
				image: whisperImage,
				assetRoot: cfg.assetRoot,
				on: whisperBubbleOn
			});
			if (bubbleOn && balance && (cfg.balanceEnabled || balanceManual)) return h(BalanceBubble, {
				state: balance,
				on: bubbleOn
			});
			if (workBubbleOn && workText && cfg.workStatusEnabled) return h(WhisperBubble, {
				text: workText,
				on: workBubbleOn
			});
			return null;
		})();
		const commonVideoProps = {
			muted: true,
			playsInline: true,
			autoPlay: true
		};
		const hitProps = {
			className: "dsh-whale-girl-hit",
			style: {
				left: HIT_BOX.x0 / 640 * 100 + "%",
				top: HIT_BOX.y0 / 360 * 100 + "%",
				width: (HIT_BOX.x1 - HIT_BOX.x0) / 640 * 100 + "%",
				height: (HIT_BOX.y1 - HIT_BOX.y0) / 360 * 100 + "%"
			},
			onClick: handleClick,
			onPointerDown: handlePointerDown,
			onPointerMove: handlePointerMove,
			onPointerUp: handlePointerUp,
			onPointerCancel: handlePointerUp,
			onPointerEnter: (e) => {
				placeTip(e.clientX, e.clientY);
				setTipOn(true);
			},
			onPointerLeave: () => setTipOn(false),
			onContextMenu: handleContextMenu,
			"aria-label": cfg.name
		};
		return h("div", {
			ref: rootRef,
			className: "dsh-whale-girl-root",
			"data-corner": corner,
			"data-facing": facing,
			style: Object.assign({
				"--dsh-whale-girl-size": size + "px",
				"--dsh-whale-girl-mx": margin.x + "px",
				"--dsh-whale-girl-my": margin.y + "px",
				"--dsh-whale-girl-font-bubble": fontPx.bubble + "px",
				"--dsh-whale-girl-font-tip": fontPx.tip + "px"
			}, rootStyle),
			children: [
				bubbleNode,
				h("div", {
					ref: stageRef,
					className: "dsh-whale-girl-stage",
					style: stageStyle,
					children: [
						h("video", Object.assign({}, commonVideoProps, {
							ref: videoARef,
							className: "dsh-whale-girl-video is-front"
						})),
						h("video", Object.assign({}, commonVideoProps, {
							ref: videoBRef,
							className: "dsh-whale-girl-video"
						})),
						h("div", hitProps)
					]
				}),
				h("div", {
					ref: tipRef,
					className: TOOLTIP_CLASS + (tipOn ? " is-on" : ""),
					"aria-hidden": "true",
					children: cfg.name
				})
			]
		});
	}
	/** 多开容器：一次拉取成品配置 → 拍平 → 渲染多个 PetCard */
	function PetMulti() {
		const [pets, setPets] = useState([]);
		const [ready, setReady] = useState(false);
		const arenaRef = useRef({ slots: {} });
		const [balance, setBalance] = useState(null);
		const [balanceTick, setBalanceTick] = useState(0);
		const [balanceNoticeTick, setBalanceNoticeTick] = useState(0);
		const [balanceManual, setBalanceManual] = useState(false);
		const noticeKeyRef = useRef(null);
		const applyBalanceRef = useRef(() => {});
		applyBalanceRef.current = (state, explicit) => {
			setBalance(state);
			setBalanceManual(explicit);
			if (state.ok) {
				setBalanceTick((t) => t + 1);
				return;
			}
			const { show, key } = decideBalanceNotice(state, noticeKeyRef.current, explicit);
			noticeKeyRef.current = key;
			if (show) setBalanceNoticeTick((t) => t + 1);
			if (state.reason !== "unsupported") console.error("[dsh-whale-girl] 余额查询失败 reason=" + state.reason + (state.message ? " " + state.message : ""));
		};
		const [workStatus, setWorkStatus] = useState(null);
		const [workStatusTick, setWorkStatusTick] = useState(0);
		useEffect(() => {
			const family = pets[0]?.font?.family;
			if (family === void 0) return;
			document.documentElement.style.setProperty("--dsh-whale-girl-font-family", fontStackOf(family));
		}, [pets]);
		useEffect(() => {
			let alive = true;
			/** 唯一填充点：host 成品聚合 → 渲染列表。初始加载与设置页保存/同步后重载都走这里——
			
			*  条目级字段（动画池/权重/刷新周期/物理参数/工作状态文案）只由 flattenConfigPets 吹入，
			
			*  容器不再自己拼任何字段（曾经的第二份补吹实现漏过 physics，导致新增/同步后拖不动）。 */
			const applyMerged = (merged) => {
				const main = merged?.main;
				if (typeof main !== "object" || main === null) throw new Error("配置响应不是成品聚合（host 版本不匹配？）");
				const flattened = flattenConfigPets(merged);
				petBridge.current = flattened;
				petBridge.template = Array.isArray(main.pets) ? main.pets[0] ?? void 0 : void 0;
				setPets(flattened);
			};
			/** 拉成品聚合：host readAllConfig 的输出（字段填满、绝对正确），客户端零校验零兜底 */
			const loadMerged = async () => {
				const r = await fetch("/dsh-whale-girl/config", { cache: "no-store" });
				if (!r.ok) throw new Error("config HTTP " + r.status);
				return await r.json();
			};
			(async () => {
				try {
					const merged = await loadMerged();
					if (!alive) return;
					applyMerged(merged);
					setReady(true);
				} catch (e) {
					console.error("[dsh-whale-girl] 配置加载失败", e);
				}
			})();
			petBridge.reload = (merged) => {
				(async () => {
					try {
						const next = merged ?? await loadMerged();
						if (!alive) return;
						applyMerged(next);
					} catch (e) {
						console.error("[dsh-whale-girl] 配置重载失败，保留当前渲染列表", e);
					}
				})();
			};
			return () => {
				alive = false;
				petBridge.reload = () => {};
			};
		}, []);
		const visiblePets = pets.filter((p) => isWebVisible(p.display));
		const [sayTick, setSayTick] = useState(0);
		const sayRef = useRef({});
		const [animCueTick, setAnimCueTick] = useState(0);
		const animCueRef = useRef({});
		useEffect(() => {
			if (!ready) return;
			let alive = true;
			let baseline = null;
			let configBaseline;
			const poll = async () => {
				try {
					const s = await fetchState();
					if (!alive || !s) return;
					if (configBaseline === void 0) configBaseline = s.configVersion;
					else if (s.configVersion !== void 0 && s.configVersion !== configBaseline) {
						configBaseline = s.configVersion;
						petBridge.reload();
					}
					if (baseline === null) {
						baseline = flattenCounters(s);
						return;
					}
					for (const { path, leaf: leaf$1 } of takeChanged(s, baseline)) {
						if (leaf$1.data === null) continue;
						if (path === "sections.balance") {
							const hit = readBalance(leaf$1);
							if (hit) applyBalanceRef.current(hit.state, hit.manual);
						} else if (path === "sections.workStatus") {
							const snap = readWorkStatus(leaf$1);
							if (snap) {
								setWorkStatus(snap);
								setWorkStatusTick((t) => t + 1);
							}
						} else if (path === "sections.notify") notifyFromFrame(leaf$1.data);
						else if (path.startsWith("pets.") && path.endsWith(".say")) {
							const petId = path.slice(5, -4);
							const said = readSay(leaf$1);
							if (said) {
								sayRef.current[petId] = {
									...said,
									seq: (sayRef.current[petId]?.seq ?? 0) + 1
								};
								setSayTick((t) => t + 1);
							}
						} else if (path.startsWith("pets.") && path.endsWith(".anim")) {
							const petId = path.slice(5, -5);
							const hit = readAnim(leaf$1);
							if (hit) {
								animCueRef.current[petId] = {
									name: hit.name,
									seq: (animCueRef.current[petId]?.seq ?? 0) + 1
								};
								setAnimCueTick((t) => t + 1);
							}
						}
					}
				} catch {}
			};
			statePoller.now = () => void poll();
			poll();
			const timer = window.setInterval(() => void poll(), 1e3);
			return () => {
				alive = false;
				statePoller.now = () => {};
				window.clearInterval(timer);
			};
		}, [ready]);
		return ready ? visiblePets.map((p) => h(PetCard, {
			key: p.id,
			cfg: p,
			balance,
			balanceTick,
			balanceNoticeTick,
			balanceManual,
			workStatus,
			workStatusTick,
			say: sayRef.current[p.id],
			sayTick,
			animCue: animCueRef.current[p.id],
			animCueTick,
			arena: arenaRef
		})) : null;
	}
	return PetMulti;
}

//#endregion
//#region src/client/workspace.ts
/** 服务端口径与 host 路由一致 */
const PREFIX$1 = "/dsh-whale-girl";
function makeWorkspaceIcon(rt) {
	const { h } = rt;
	return function WorkspaceIcon(props) {
		const size = typeof props.size === "number" && props.size > 0 ? props.size : 20;
		return h("svg", {
			width: size,
			height: size,
			viewBox: "0 0 24 24",
			fill: "none",
			"aria-hidden": true,
			style: {
				display: "block",
				opacity: props.active === true ? 1 : .75
			}
		}, h("path", {
			d: "M4 14c0-3.3 2.7-6 6-6h2c3.9 0 7 3.1 7 7 0 .6-.5 1-1 1H5c-.6 0-1-.4-1-1z",
			fill: "currentColor",
			opacity: .9
		}), h("path", {
			d: "M19 15c1.5-.5 2.5-1.5 3-3-.2 2-1 3.5-2.4 4.5",
			fill: "currentColor",
			opacity: .7
		}), h("circle", {
			cx: 8,
			cy: 12,
			r: .9,
			fill: "white"
		}), h("path", {
			d: "M9 6c0-1.5.8-2.7 2-3.5-.3 1.2-.2 2.2.3 3",
			stroke: "currentColor",
			"stroke-width": 1.4,
			"stroke-linecap": "round"
		}));
	};
}
function makeWorkspacePanel(rt) {
	const { h, useState, useEffect, useCallback, t } = rt;
	return function WorkspacePanel() {
		const [session, setSession] = useState(null);
		const [sightOn, setSightOn] = useState(false);
		const [autoOn, setAutoOn] = useState(false);
		const [estop, setEstop] = useState("unknown");
		const [msg, setMsg] = useState("");
		const refresh = useCallback(async () => {
			try {
				const s = await fetch(`${PREFIX$1}/autoplay/session`);
				if (s.ok) {
					const d = await s.json();
					setSession(d.session ?? null);
				}
				const c = await fetch(`${PREFIX$1}/autoplay/config`);
				if (c.ok) {
					const d = await c.json();
					setAutoOn(d.config?.enabled === true);
					setEstop(d.estop?.state ?? "unknown");
				}
				const g = await fetch(`${PREFIX$1}/sight/config`);
				if (g.ok) {
					const d = await g.json();
					setSightOn(d.config?.enabled === true);
				}
			} catch {}
		}, []);
		useEffect(() => {
			refresh();
			const timer = setInterval(() => void refresh(), 3e3);
			return () => clearInterval(timer);
		}, [refresh]);
		const endSession = async () => {
			try {
				const res = await fetch(`${PREFIX$1}/autoplay/end`, { method: "POST" });
				const d = await res.json();
				setMsg(d.ended?.summary ?? t("wsNothing"));
				await refresh();
			} catch {
				setMsg(t("wsFailed"));
			}
		};
		const runOne = async () => {
			setMsg(t("wsRunning"));
			try {
				const res = await fetch(`${PREFIX$1}/autoplay/run`, { method: "POST" });
				const d = await res.json();
				setMsg(d.kind === "planned" ? `${t("wsPlanned")}：${d.thought ?? ""}` : d.kind === "skipped" ? `${t("wsSkipped")}：${d.reason ?? ""}` : `${t("wsFailed")}：${d.message ?? d.reason ?? ""}`);
				await refresh();
			} catch {
				setMsg(t("wsFailed"));
			}
		};
		const dot = (on, label) => h("div", { style: {
			display: "flex",
			alignItems: "center",
			gap: "6px",
			fontSize: "13px"
		} }, [h("span", {
			key: "d",
			style: {
				width: "8px",
				height: "8px",
				borderRadius: "50%",
				background: on ? "var(--dsw-alias-state-success-primary, #2e9e4f)" : "var(--dsw-alias-label-secondary)"
			}
		}), h("span", {
			key: "l",
			children: `${label}${on ? t("wsOn") : t("wsOff")}`
		})]);
		return h("div", { style: {
			padding: "16px 18px",
			display: "flex",
			flexDirection: "column",
			gap: "12px"
		} }, [
			h("h2", {
				key: "title",
				style: {
					margin: 0,
					fontSize: "17px"
				},
				children: t("wsTitle")
			}),
			h("p", {
				key: "hint",
				style: {
					margin: 0,
					fontSize: "12px",
					opacity: .7
				},
				children: t("wsHint")
			}),
			h("div", {
				key: "session",
				style: { fontSize: "13px" }
			}, [h("div", {
				key: "a",
				children: session === null ? t("wsNoSession") : `${session.gameTitle ?? ""}`
			}), session === null ? null : h("div", {
				key: "b",
				style: { opacity: .7 },
				children: `${session.steps ?? 0} / ${session.cap ?? 0} ${t("wsSteps")}`
			})]),
			dot(sightOn, t("wsSight")),
			dot(autoOn, t("wsAutoplay")),
			h("div", {
				key: "estop",
				style: {
					fontSize: "12px",
					opacity: .8
				}
			}, [`${t("wsEstop")}：${estop === "ready" ? t("wsReady") : t("wsStopped")}`]),
			h("div", {
				key: "actions",
				style: {
					display: "flex",
					gap: "8px",
					flexWrap: "wrap",
					marginTop: "4px"
				}
			}, [h("button", {
				key: "r",
				type: "button",
				onClick: () => void runOne(),
				children: t("wsRun")
			}), h("button", {
				key: "e",
				type: "button",
				onClick: () => void endSession(),
				children: t("wsEnd")
			})]),
			msg === "" ? null : h("div", {
				key: "msg",
				style: {
					fontSize: "12px",
					opacity: .85
				},
				children: msg
			})
		]);
	};
}

//#endregion
//#region src/client/play-status.ts
/** 宿主路由前缀 */
const PREFIX = "/dsh-whale-girl";
const ROOT_STYLE = [
	"position:fixed",
	"right:16px",
	"bottom:150px",
	"z-index:2147483000",
	"display:flex",
	"align-items:center",
	"gap:8px",
	"pointer-events:auto",
	"user-select:none"
].join(";");
const DOT_STYLE = [
	"width:8px",
	"height:8px",
	"border-radius:50%",
	"background:#7aa2ff",
	"box-shadow:0 0 8px rgba(122,162,255,.8)"
].join(";");
const DOT_IDLE_STYLE = DOT_STYLE + ";background:#8892a6;box-shadow:none";
const LABEL_STYLE = [
	"font-size:12px",
	"color:#cfe0ff",
	"background:rgba(20,28,48,.82)",
	"border:1px solid rgba(255,255,255,.22)",
	"padding:4px 10px",
	"border-radius:8px",
	"white-space:nowrap",
	"max-width:360px",
	"overflow:hidden",
	"text-overflow:ellipsis",
	"box-shadow:0 4px 16px rgba(0,0,0,.35)"
].join(";");
const STOP_STYLE = [
	"font-size:12px",
	"color:#fff",
	"background:rgba(214,86,86,.85)",
	"border:1px solid rgba(255,255,255,.22)",
	"padding:4px 10px",
	"border-radius:8px",
	"cursor:pointer"
].join(";");
/** 把 CSS 字符串转成 React 的 style 对象（React 不接受字符串） */
function parseStyle(css$1) {
	const out = {};
	for (const part of css$1.split(";")) {
		const index = part.indexOf(":");
		if (index <= 0) continue;
		const key = part.slice(0, index).trim();
		const value = part.slice(index + 1).trim();
		if (key === "" || value === "") continue;
		out[key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
	}
	return out;
}
const styles = {
	root: parseStyle(ROOT_STYLE),
	dot: parseStyle(DOT_STYLE),
	dotIdle: parseStyle(DOT_IDLE_STYLE),
	label: parseStyle(LABEL_STYLE),
	stop: parseStyle(STOP_STYLE)
};
/** 最近一次状态停止后，浮标还显示多久（毫秒）：够主人看到「为什么停了」 */
const LINGER_MS = 12e3;
/** 状态快照 → 一句话 */
function describe$1(snap) {
	const rounds = typeof snap.rounds === "number" && snap.rounds > 0 ? `（第 ${snap.rounds} 轮）` : "";
	const spent = typeof snap.lastRoundMs === "number" ? ` · ${(snap.lastRoundMs / 1e3).toFixed(1)}s` : "";
	switch (snap.state) {
		case "thinking": return "代打 · 思考中…" + rounds;
		case "waiting": return "代打 · " + (snap.lastMessage ?? "等待中") + rounds + spent;
		case "stopped":
		case "error": return snap.lastMessage ?? "代打已停";
		default: return "代打 · " + (snap.lastMessage ?? "");
	}
}
function makePlayStatus(rt) {
	const { h, useState, useCallback, useEffect } = rt;
	return function PlayStatus() {
		const [snap, setSnap] = useState(null);
		const [busy, setBusy] = useState(false);
		useEffect(() => {
			let alive = true;
			const tick = async () => {
				try {
					const res = await fetch(`${PREFIX}/autoplay/play`, { cache: "no-store" });
					if (!res.ok) return;
					const data = await res.json();
					if (alive) setSnap(data.play ?? null);
				} catch {}
			};
			tick();
			const timer = setInterval(() => void tick(), 700);
			return () => {
				alive = false;
				clearInterval(timer);
			};
		}, []);
		const stop = useCallback(async () => {
			setBusy(true);
			try {
				await fetch(`${PREFIX}/autoplay/play/stop`, { method: "POST" });
			} catch {} finally {
				setBusy(false);
			}
		}, []);
		if (snap === null) return null;
		const running = snap.running === true;
		const recent = typeof snap.updatedAtMs === "number" && Date.now() - snap.updatedAtMs < LINGER_MS;
		if (!running && !recent) return null;
		if (!running && snap.state === "idle") return null;
		const text = describe$1(snap);
		return h("div", {
			style: styles.root,
			children: [
				h("span", {
					key: "dot",
					style: running ? styles.dot : styles.dotIdle
				}),
				h("span", {
					key: "label",
					style: styles.label,
					title: text,
					children: text
				}),
				running ? h("button", {
					key: "stop",
					type: "button",
					style: styles.stop,
					disabled: busy,
					onClick: (event) => {
						event.preventDefault();
						stop();
					},
					children: "停止"
				}) : null
			]
		});
	};
}

//#endregion
//#region src/client/command-faces.ts
function installCommandFaces(commandUi, faces) {
	const original = commandUi.candidates;
	if (typeof original !== "function") {
		console.warn("[dsh-whale-girl] 命令图标不可用：commandUi.candidates 缺失（命令本身仍可用，只是没有图标）");
		return () => {};
	}
	const patched = async (session, req) => {
		const rows = await original.call(commandUi, session, req);
		try {
			if (!Array.isArray(rows)) return rows;
			return rows.map((raw) => {
				if (raw === null || typeof raw !== "object") return raw;
				const row = raw;
				const face = faces.get(typeof row.name === "string" ? row.name : "");
				if (face === void 0 || row.icon !== void 0) return row;
				return {
					...row,
					label: face.label(),
					icon: face.icon
				};
			});
		} catch (error) {
			console.warn("[dsh-whale-girl] 命令图标补丁异常，本次退回原始菜单行：" + (error instanceof Error ? error.message : String(error)));
			return rows;
		}
	};
	commandUi.candidates = patched;
	return () => {
		if (commandUi.candidates === patched) commandUi.candidates = original;
	};
}

//#endregion
//#region src/client/nav-icon.ts
/**
* 设置面板导航图标补丁 —— 把「桌宠配置」那一行的兜底齿轮换成指定图标。
*
* ## 为什么需要它
*
* DSH 设置面板的导航图标是**按分区 id 硬编码的白名单 + 兜底齿轮**，没有任何给第三方
* 分区配图标的入口：
*
*   · `dsh-client-ui-settings-general/lib/client.js` 的 `navIcon(id)`（:243-269）只认
*     account / models / agent-presets / plugins / archived-sessions 五个 id，其余
*     一律 `IconSettingsOutlineMedium` —— 源码注释原文就是 "unknown ids fall back
*     to the settings gear"；
*   · 导航行数据是 `ctx.slots.entries("settings.section")` 投影出来的
*     `{ id, order, label }`（同文件 :1023-1028），**没有图标位**；
*   · slot 契约里也没有：ui-slots 的 `KindOptions`（list 分支，:564-569）与
*     `StoredEntry.options`（:621-627）都只有 id / order / label / priority，
*     `settings.section` 的 owner props 只有 `{ close }`。
*
* `navIcon` 是 settings-general 模块内部的私有函数，外部拿不到引用，所以只能在
* **DOM 层**做：盯住设置面板（shell 用 `createPortal(..., document.body)` 直接挂在
* body 上）→ 按行标题认出我们那一行 → 打标记 → 用 CSS 盖住齿轮、画上我们的字形。
*
* ## 为什么是「打标记 + CSS」而不是「换掉那个 svg」
*
* 那个 `<svg>` 是 shell 的 React 节点。`replaceWith` 成自己的节点后，React 手里仍
* 攥着已脱离文档的旧 svg，那一行卸载时 React 会对它 `removeChild` →
* `NotFoundError` 直接崩。本模块**不动 DOM 结构**：只加一个 React 从不 diff 的
* `data-*` 属性，字形交给 `::before` + `mask` 画，React 全程无感。
*
* ## 认行只能靠标题文本
*
* 行里只有 id / order / label 三个字段，而投影到 DOM 的只有 label —— `<button>` 上
* 只有 class / aria-current / data-modal-autofocus，既没有 id 也没有 order。所以按标题
* 文本认。不能用 `:nth-child`：`account` 行是**条件出现**的（凭据存储后才注册），
* 位置会漂。
*
* ## 降级策略（保证绝不会把设置面板弄坏）
*
* 1. 环境缺 document / MutationObserver → 完全不装，只告警；
* 2. 图标渲不成 SVG（react-dom 不可用等）→ 完全不装，只告警（齿轮照旧）；
* 3. 认不出那一行 → 什么都不做（齿轮照旧），不报错；
* 4. 面板反复开关 → 观察者重新打标记，幂等。
*
* 将来 DSH 给 `settings.section` 加上 icon 选项后，删掉本模块与调用点即可。
*/
/** 注入的样式表去重标记（与宠物页面 / 设置页同一套 `data-plugin-css` 约定）。 */
const STYLE_TAG = "dsh-whale-girl/nav-icon.css";
/** 打在目标行 `<button>` 上的标记属性：React 从不 diff 它，重渲染 / 切语言都不会掉。 */
const MARK = "data-dsh-whale-girl-nav";
/** 设置面板根节点：shell 用 `createPortal(..., document.body)`（settings-general lib/client.js:341）。 */
const PANEL_SELECTOR = "[data-shortcut-modal=\"settings\"]";
/**
* 面板内部的类名来自 CSS Modules，**哈希前缀会随 DSH 构建变**（当前是 `VOzbGW_navList`），
* 但 `navList` / `navCell` / `navLabel` / `navIcon` 这些名字是源码里写死的
* （`"navIcon": "VOzbGW_navIcon"`），所以只匹配名字部分，不硬编码全名。
*/
const LIST_SELECTOR = "[class*=\"navList\"]";
const CELL_SELECTOR = "[class*=\"navCell\"]";
const LABEL_SELECTOR = "[class*=\"navLabel\"]";
function svgMaskUri(svg) {
	const source = svg.trim();
	if (source === "") return "";
	const namespaced = /<svg[^>]*\sxmlns=/i.test(source) ? source : source.replace(/<svg\b/i, "<svg xmlns=\"http://www.w3.org/2000/svg\"");
	return "url(\"data:image/svg+xml," + encodeURIComponent(namespaced.split("currentColor").join("#000")) + "\")";
}
/** 换字形用的 CSS：盖住齿轮，用 `::before` + mask 画上我们的图标。 */
function cssFor(glyph) {
	return [
		"/* 「桌宠配置」行的导航图标：见 dsh-whale-girl/src/client/nav-icon.ts 的模块注释 */",
		"[" + MARK + "] [class*=\"navIcon\"]{display:none}",
		"[" + MARK + "]::before{content:\"\";flex:none;width:16px;height:16px;background-color:currentColor;-webkit-mask:" + glyph + " center/16px 16px no-repeat;mask:" + glyph + " center/16px 16px no-repeat}"
	].join("\n");
}
/** 注入样式表（只注入一次）。 */
function injectCss(doc, glyph) {
	if (doc.querySelector("style[data-plugin-css=\"" + STYLE_TAG + "\"]") !== null) return;
	const tag = doc.createElement("style");
	tag.dataset.plugin = "dsh-whale-girl";
	tag.dataset.pluginCss = STYLE_TAG;
	tag.textContent = cssFor(glyph);
	doc.head.appendChild(tag);
}
/** 异常 → 单行文案（告警用）。 */
function describe(error) {
	return error instanceof Error ? error.message : String(error);
}
function installSectionNavIcon(target) {
	const doc = typeof document === "undefined" ? void 0 : document;
	const Observer = typeof MutationObserver === "undefined" ? void 0 : MutationObserver;
	if (doc === void 0 || Observer === void 0 || doc.body === null) {
		console.warn("[dsh-whale-girl] 设置页导航图标不可用：缺少 document / body / MutationObserver（齿轮照旧）");
		return () => {};
	}
	let glyph;
	try {
		glyph = svgMaskUri(target.renderSvg());
	} catch (error) {
		console.warn("[dsh-whale-girl] 设置页导航图标不可用：图标渲染失败（齿轮照旧）：" + describe(error));
		return () => {};
	}
	if (glyph === "") {
		console.warn("[dsh-whale-girl] 设置页导航图标不可用：图标渲成了空 SVG（齿轮照旧）");
		return () => {};
	}
	injectCss(doc, glyph);
	let warned = false;
	/** 给面板里标题匹配的那一行打标记（幂等；已打过的不再读标题）。 */
	const markPanel = (panel) => {
		try {
			const wanted = target.label();
			if (wanted === "") return;
			const list = panel.querySelector(LIST_SELECTOR);
			if (list === null) return;
			for (const cell of list.querySelectorAll(CELL_SELECTOR)) {
				if (cell.getAttribute(MARK) !== null) continue;
				if (cell.querySelector(LABEL_SELECTOR)?.textContent === wanted) cell.setAttribute(MARK, "");
			}
		} catch (error) {
			if (!warned) {
				warned = true;
				console.warn("[dsh-whale-girl] 设置页导航图标补丁异常，本次跳过（齿轮照旧）：" + describe(error));
			}
		}
	};
	let watched;
	let panelObserver;
	const sync = () => {
		const panel = doc.querySelector(PANEL_SELECTOR);
		if (panel === null) {
			panelObserver?.disconnect();
			panelObserver = void 0;
			watched = void 0;
			return;
		}
		markPanel(panel);
		if (panel === watched) return;
		panelObserver?.disconnect();
		watched = panel;
		panelObserver = new Observer(() => {
			markPanel(panel);
		});
		panelObserver.observe(panel, {
			childList: true,
			subtree: true
		});
	};
	sync();
	const bodyObserver = new Observer(sync);
	bodyObserver.observe(doc.body, { childList: true });
	return () => {
		bodyObserver.disconnect();
		panelObserver?.disconnect();
	};
}

//#endregion
//#region src/client/app.ts
function makeFactory() {
	return (require) => {
		const module = { exports: {} };
		const react = require("react");
		const { useEffect, useRef, useState, useCallback } = react;
		const { jsx: h } = require("react/jsx-runtime");
		let primitives;
		try {
			primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		} catch (error) {
			console.warn("[dsh-whale-girl] 图标模块不可用：" + (error instanceof Error ? error.message : String(error)));
		}
		let renderIconSvg;
		try {
			const { createRoot } = require("react-dom/client");
			const { flushSync } = require("react-dom");
			renderIconSvg = (icon) => {
				const holder = document.createElement("div");
				const root = createRoot(holder);
				try {
					flushSync(() => root.render(h(icon, { size: 16 })));
					return holder.innerHTML;
				} finally {
					root.unmount();
				}
			};
		} catch (error) {
			console.warn("[dsh-whale-girl] 图标渲染器不可用（react-dom 缺失）：" + (error instanceof Error ? error.message : String(error)));
		}
		const PetMulti = makePetUI({
			h,
			useState,
			useEffect,
			useRef
		});
		const name = "dsh-whale-girl";
		const inject = [
			"slots",
			"locale",
			"connection",
			"remote",
			"remote.commands",
			"commandUi"
		];
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "dsh-whale-girl: dictionaries");
			const t = ctx.locale.bind(NS);
			ctx.effect(() => initNotify(), "dsh-whale-girl: notifications");
			ctx.effect(() => {
				const commandUi = ctx.get?.("commandUi");
				if (!commandUi || typeof commandUi.decorate !== "function") {
					console.warn("[dsh-whale-girl] 命令选择框不可用：commandUi 服务缺失（/pet 仍可手输 id 或名字）");
					return () => {};
				}
				return commandUi.decorate({
					name: "whale-pet",
					available: () => true,
					ui: {
						kind: "popupSelect",
						options: async () => petBridge.current.map((p) => ({
							id: p.id,
							label: p.name || p.id,
							detail: (p.assetRoot && p.assetRoot !== p.id ? p.assetRoot + " / " : "") + p.id
						})),
						onSelect: async (option, session) => {
							await ctx.remote?.commands?.execute(session.sessionId, "/pet " + option.id, []);
						}
					}
				});
			}, "dsh-whale-girl: /pet picker");
			ctx.effect(() => {
				const commandUi = ctx.get?.("commandUi");
				const icons = primitives;
				if (commandUi === void 0 || icons === void 0) {
					console.warn("[dsh-whale-girl] 命令图标不可用（命令本身仍可用，只是没有图标）");
					return () => {};
				}
				return installCommandFaces(commandUi, new Map([
					["whale-chat", {
						label: () => t("cmd.chat"),
						icon: icons.IconQueueOutlineRegular
					}],
					["whale-pet", {
						label: () => t("cmd.pet"),
						icon: icons.IconUsersOutlineRegular
					}],
					["whale-balance", {
						label: () => t("cmd.balance"),
						icon: icons.IconGaugeOutlineRegular
					}]
				]));
			}, "dsh-whale-girl: command faces");
			ctx.effect(() => {
				const renderIcon = renderIconSvg;
				const icon = primitives?.IconSlidersTwoOutlineMedium;
				if (renderIcon === void 0 || icon === void 0) {
					console.warn("[dsh-whale-girl] 设置页导航图标不可用（那一行仍是齿轮）");
					return () => {};
				}
				return installSectionNavIcon({
					label: () => t("nav"),
					renderSvg: () => renderIcon(icon)
				});
			}, "dsh-whale-girl: settings nav icon");
			ctx.slots.inject("shell.overlay", function* () {
				yield ctx.slots.register({
					name: "shell.overlay",
					id: "whale-girl",
					order: 1e3
				}, () => h(PetMulti, {}));
			});
			const VoiceButton = makeVoiceButton({
				h,
				useState,
				useRef,
				useCallback,
				useEffect
			});
			ctx.slots.inject("shell.overlay", function* () {
				yield ctx.slots.register({
					name: "shell.overlay",
					id: "whale-girl-voice",
					order: 1001
				}, () => h(VoiceButton, { label: (key) => t(key) }));
			});
			const PlayStatus = makePlayStatus({
				h,
				useState,
				useCallback,
				useEffect
			});
			ctx.slots.inject("shell.overlay", function* () {
				yield ctx.slots.register({
					name: "shell.overlay",
					id: "whale-girl-play",
					order: 1002
				}, () => h(PlayStatus, {}));
			});
			const PetConfigSection = makePetConfigSection({
				h,
				useState,
				useEffect,
				useRef,
				useCallback,
				t
			});
			const WorkspaceIcon = makeWorkspaceIcon({
				h,
				useState,
				useEffect,
				useCallback,
				t
			});
			const WorkspacePanel = makeWorkspacePanel({
				h,
				useState,
				useEffect,
				useCallback,
				t
			});
			ctx.slots.inject("sidebar.panellist", function* () {
				yield ctx.slots.register({
					name: "sidebar.panellist",
					id: "whale-girl",
					order: 200,
					label: () => t("wsTitle")
				}, WorkspaceIcon);
			});
			ctx.slots.inject("main", function* () {
				yield ctx.slots.register({
					name: "main",
					key: "whale-girl"
				}, WorkspacePanel);
			});
			ctx.slots.inject("settings.section", function* () {
				yield ctx.slots.register({
					name: "settings.section",
					id: "whale-girl-config",
					order: 30,
					label: () => t("nav"),
					inject: () => ({ t })
				}, PetConfigSection);
			});
		}
		module.exports = {
			apply,
			inject,
			name
		};
		return module.exports;
	};
}

//#endregion
//#region src/client/index.ts
window.__ModuleLoader__.load({
	id: "dsh-whale-girl",
	factory: makeFactory()
});

//#endregion
})();