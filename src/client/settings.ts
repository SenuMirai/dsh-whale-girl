/**
 * 桌宠配置管理设置页（settings.section 插槽，id: pet-config）
 *
 * - 多开：管理多个桌宠，每个宠物独立 id/name/size/位置（corner + marginX/Y）
 * - 数据流：设置页持有「main 条目宠物列表」→ 保存时全量 PUT /dsh-whale-girl/config
 *   （写用户层 main-config.jsonc = 可编辑层，文件宠物永不回写）
 * - 数据入口：配置由 host readAllConfig 合并为**成品**（GET /dsh-whale-girl/config），
 *   设置页只读 main 条目（可编辑）+ 统计文件宠物条数，不做任何校验
 * - 即时生效：保存/同步后用 host 返回的**成品聚合**调用 petBridge.reload，
 *   容器走同一份 flattenConfigPets 重新渲染，无需刷新页面（设置页不自己拼任何条目级字段）
 *
 * 样式对齐官方设置页：max-width 720px、全走 --dsw-alias-* 语义 token（主题跟随）。
 */
import { PET_DISPLAYS } from '../shared/config';
import { DEFAULT_FONT, FONT_PRESETS, FONT_SIZE_MAX, FONT_SIZE_MIN } from '../shared/fonts';
import { DEFAULT_PHYSICS } from '../shared/physics';
import { NOTIFY_ICONS, reloadNotifications, requestNotificationPermission } from './notify';
import { VOICE_CONFIG_EVENT } from './voice-client';
import type { Corner, FontConfig, FontFamilyId, ModelSelection, Pet, PetDisplay, PhysicsParams } from '../shared/types';
import type { ChangeEvent, Dispatch, FunctionComponent, SetStateAction } from 'react';
import type * as ReactNS from 'react';
import type { jsx } from 'react/jsx-runtime';

/** 容器与设置页共享的桥（同一 bundle 单例）：
 * current=最新完整宠物列表（**成品拍平**，含条目级字段与文件宠物，默认空；容器是唯一写入方）；
 * reload=容器注册的重载回调（未注册时为无操作函数）：传 host 保存接口返回的成品聚合即直接拍平，
 *   缺省则由容器自行 GET /config；template=main 条目的宠物[0]（「添加宠物」用它作为默认配置） */
export const petBridge: {
  current: Pet[];
  reload: (merged?: Record<string, Record<string, unknown>>) => void;
  template: Pet | undefined;
} = {
  current: [],
  reload: () => {},
  template: undefined,
};

/** 字典命名空间（必须与 dsh-pet 的 `pet.config` 区分：同 ns 会互相覆盖文案） */
export const NS = 'whale-girl.config';

/** 一处「服务商 + 模型」是否合法：**要么都留空（= 跟随当前对话）要么都非空**。
 *  与宿主 config.ts 的 modelSelectionValid 同一套规则（非法宿主回 400，这里先就地给红字提示）。 */
const modelPairValid = (m: ModelSelection): boolean => (m.provider.trim() === '') === (m.model.trim() === '');

/** 候选清单里的一组：一个服务商 + 它名下的模型（GET /models 的响应形态） */
interface ModelCatalogGroup {
  id: string;
  name: string;
  models: Array<{ id: string; name: string }>;
}

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
  // 触发器：与设置页其它控件同款描边，右侧箭头表示可展开
  '.dsh-whale-girl-mp{position:relative;min-width:0;display:flex;flex-direction:column;gap:4px}',
  '.dsh-whale-girl-mp__trigger{display:flex;align-items:center;gap:6px;width:100%;max-width:340px;height:28px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;text-align:left;cursor:pointer;outline:none}',
  '.dsh-whale-girl-mp__trigger:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary)}',
  '.dsh-whale-girl-mp__trigger:focus-visible{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}',
  '.dsh-whale-girl-mp__trigger:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}',
  '.dsh-whale-girl-mp__label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
  '.dsh-whale-girl-mp__sub{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex-shrink:1000;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary))}',
  '.dsh-whale-girl-mp__chevron{flex:none;margin-left:auto;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary));transition:transform .12s}',
  '.dsh-whale-girl-mp__chevron.is-open{transform:rotate(180deg)}',
  // 浮层：position:fixed（与 DSH 一致——脱离设置页的滚动容器，不被 overflow 裁掉）
  // 浮层：position:fixed（与 DSH 一致——脱离设置页的滚动容器，不被 overflow 裁掉）；
  // z-index 取与插件右键菜单同一档（2147483000），保证压得住 DSH 自己的层叠上下文
  '.dsh-whale-girl-mp__panel{position:fixed;z-index:2147483000;display:flex;flex-direction:column;gap:4px;padding:4px;overflow:hidden;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md,10px);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-prominent,0 8px 30px rgba(0,0,0,.35));color:var(--dsw-alias-label-primary)}',
  '.dsh-whale-girl-mp__search{box-sizing:border-box;width:100%;height:28px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;outline:none}',
  '.dsh-whale-girl-mp__search:focus{border-color:var(--dsw-alias-state-business-primary)}',
  '.dsh-whale-girl-mp__list{display:flex;flex-direction:column;min-height:0;overflow-y:auto;scrollbar-width:thin}',
  '.dsh-whale-girl-mp__group{padding:6px 8px 2px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}',
  '.dsh-whale-girl-mp__item{display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;border:none;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer}',
  '.dsh-whale-girl-mp__item:hover:not(:disabled),.dsh-whale-girl-mp__item.is-active{background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsh-whale-girl-mp__item[aria-checked="true"]{color:var(--dsw-alias-state-business-primary)}',
  '.dsh-whale-girl-mp__item:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}',
  '.dsh-whale-girl-mp__name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
  '.dsh-whale-girl-mp__check{flex:none;margin-left:auto}',
  '.dsh-whale-girl-mp__status{padding:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',

  // ===================== 设置页骨架（重构后） =====================
  // 这一段只放「伪类 / 悬浮 / 栅格」这类行内样式表达不了的东西；其余排版仍走组件里的行内 style。
  // 类名统一 dsh-whale-girl-cfg__ 前缀，不会撞 DSH 自己的类名。

  // 页面根容器与标题
  '.dsh-whale-girl-cfg{container-type:inline-size;display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}',
  '.dsh-whale-girl-cfg__title{display:flex;align-items:center;gap:6px;margin:0;font-size:16px;font-weight:500;line-height:24px}',

  // 卡片：宠物配置 / 全局开关 / AI 模型 / 物理 / 高级配置 / 卸载与存储 统一用这一个框
  '.dsh-whale-girl-cfg__card{display:flex;flex-direction:column;gap:10px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px}',
  '.dsh-whale-girl-cfg__cardHead{display:flex;align-items:center;gap:6px;min-height:20px}',
  '.dsh-whale-girl-cfg__cardTitle{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}',

  // 栅格：列数固定 → 行与行的控件自然对齐成一列
  '.dsh-whale-girl-cfg__grid3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px 16px;align-items:end}',
  '.dsh-whale-girl-cfg__grid4{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px 16px;align-items:end}',
  '.dsh-whale-girl-cfg__grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 16px;align-items:end}',

  '@container (max-width:600px){.dsh-whale-girl-cfg__grid4{grid-template-columns:repeat(2,minmax(0,1fr))}}',
  '@container (max-width:400px){.dsh-whale-girl-cfg__grid2,.dsh-whale-girl-cfg__grid3,.dsh-whale-girl-cfg__grid4{grid-template-columns:minmax(0,1fr)}}',

  // 字段：标签（+ 问号）在上、控件在下
  '.dsh-whale-girl-cfg__field{display:flex;flex-direction:column;gap:4px;min-width:0}',
  '.dsh-whale-girl-cfg__flabel{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--dsw-alias-label-secondary)}',

  // 输入 / 下拉
  '.dsh-whale-girl-cfg__inp{box-sizing:border-box;width:100%;min-height:28px;padding:4px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none}',
  '.dsh-whale-girl-cfg__inp:focus{border-color:var(--dsw-alias-state-business-primary)}',
  '.dsh-whale-girl-cfg__inp:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}',

  // 开关（勾选框 + 标题 + 问号）
  '.dsh-whale-girl-cfg__toggle{display:flex;align-items:center;gap:6px;min-width:0;font-size:13px;color:var(--dsw-alias-label-primary)}',
  '.dsh-whale-girl-cfg__toggle>label{display:inline-flex;align-items:center;gap:6px;cursor:pointer;min-width:0}',
  '.dsh-whale-girl-cfg__toggle>label>span{overflow-wrap:anywhere}',
  '.dsh-whale-girl-cfg__toggle input[type=checkbox]{flex:none;width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-state-business-primary);cursor:pointer}',

  // 问号 + 悬浮说明：解释小字全部收进这里（data-tip → ::after）
  '.dsh-whale-girl-cfg__q{position:relative;display:inline-flex;align-items:center;justify-content:center;flex:none;width:14px;height:14px;border:1px solid var(--dsw-alias-label-tertiary);border-radius:50%;color:var(--dsw-alias-label-tertiary);font-size:10px;font-style:normal;line-height:1;cursor:help;user-select:none}',
  // 气泡默认**左对齐**到问号（left:-4px），而不是居中。
  // 为什么不能居中：问号常常贴着卡片左缘（卡片头、栅格第一列、页标题），居中会让气泡
  // 往左伸出一大截，被设置页的滚动容器（overflow 会连带裁掉横向）切掉——看起来就是
  // 「气泡左边被左边框遮住」。左对齐则一律向右展开，左侧永不出界。
  '.dsh-whale-girl-cfg__q::after{display:none;content:attr(data-tip);position:absolute;left:-4px;bottom:calc(100% + 8px);width:max-content;max-width:260px;padding:6px 10px;border-radius:8px;background:var(--dsw-alias-tooltip-bg);color:#fff;font-size:12px;font-style:normal;font-weight:400;line-height:18px;text-align:left;white-space:normal;opacity:0;visibility:hidden;pointer-events:none;transition:opacity .12s ease;box-shadow:0 6px 20px rgba(0,0,0,.22);z-index:2147483000}',
  '.dsh-whale-girl-cfg__q:hover::after{display:block;opacity:1;visibility:visible}',
  // 最右一列：改为右对齐，避免气泡顶出设置页右缘
  '.dsh-whale-girl-cfg__q.is-end::after{left:auto;right:-4px}',

  // 按钮
  '.dsh-whale-girl-cfg__btn{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:8px;padding:4px 14px;font:inherit;font-size:12px;line-height:20px;cursor:pointer;white-space:nowrap}',
  // 实心主按钮**必须排除**在通用 hover 之外：interactive-bg-hover 是半透明白（#ffffff14），
  // 直接顶掉 button-info-fill 会让蓝色保存按钮一悬停就变成一块发白的透明块，非常突兀。
  // 实心按钮的 hover 走主题自己的 button-info-hover（更深的蓝）。
  '.dsh-whale-girl-cfg__btn:hover:not(:disabled):not(.is-primary){background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsh-whale-girl-cfg__btn:disabled{opacity:.5;cursor:default}',
  '.dsh-whale-girl-cfg__btn.is-primary{border-color:var(--dsw-alias-button-info-fill);background:var(--dsw-alias-button-info-fill);color:#fff}',
  '.dsh-whale-girl-cfg__btn.is-primary:hover:not(:disabled){border-color:var(--dsw-alias-button-info-hover);background:var(--dsw-alias-button-info-hover)}',
  '.dsh-whale-girl-cfg__btn.is-danger{border-color:var(--dsw-alias-state-error-secondary);color:var(--dsw-alias-state-error-primary)}',
  '.dsh-whale-girl-cfg__btn.is-sm{padding:2px 10px}',
  '.dsh-whale-girl-cfg__btn.is-ghost{border-style:dashed;color:var(--dsw-alias-label-secondary)}',

  // 宠物列表 tab
  '.dsh-whale-girl-cfg__tabs{display:flex;gap:8px;flex-wrap:wrap;align-items:center}',
  '.dsh-whale-girl-cfg__tabsLabel{font-size:12px;color:var(--dsw-alias-label-secondary)}',
  '.dsh-whale-girl-cfg__tab{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:8px;padding:4px 12px;font:inherit;font-size:13px;cursor:pointer}',
  '.dsh-whale-girl-cfg__tab:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsh-whale-girl-cfg__tab:disabled{opacity:.5;cursor:default}',
  '.dsh-whale-girl-cfg__tab.is-active{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-active)}',
  '.dsh-whale-girl-cfg__tab.is-ghost{border-style:dashed;color:var(--dsw-alias-label-secondary)}',
  // 顶部页签：把 7 块内容分页显示，避免一页铺太长要滚很久
  '.dsh-whale-girl-cfg__saveBar{position:sticky;top:0;z-index:20;display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:10px 0;margin:8px 0;background:linear-gradient(180deg,var(--dsw-alias-bg-l1,rgba(20,26,48,.96)) 70%,transparent);backdrop-filter:blur(6px)}',
  '.dsh-whale-girl-cfg__pageTabs{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin:14px 0 6px;padding-bottom:10px;border-bottom:1px solid var(--dsw-alias-border-l2)}',
  '.dsh-whale-girl-cfg__pageTab{border:none;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:8px;padding:6px 14px;font:inherit;font-size:13px;cursor:pointer;transition:background .12s,color .12s}',
  '.dsh-whale-girl-cfg__pageTab:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
  '.dsh-whale-girl-cfg__pageTab.is-active{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary);font-weight:600}',
  '.dsh-whale-girl-cfg__pageTab:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}',

  // 操作区 / 提示文字 / 路径
  '.dsh-whale-girl-cfg__actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:4px}',
  '.dsh-whale-girl-cfg__msg{margin-left:4px;font-size:12px;color:var(--dsw-alias-state-success-primary)}',
  '.dsh-whale-girl-cfg__msg.is-err{color:var(--dsw-alias-state-error-primary)}',
  '.dsh-whale-girl-cfg__note{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
  '.dsh-whale-girl-cfg__path{font-size:12px;line-height:18px;word-break:break-all;user-select:text;color:var(--dsw-alias-label-secondary)}',
  '.dsh-whale-girl-cfg__path b{color:var(--dsw-alias-label-primary);font-weight:400}',
  '.dsh-whale-girl-cfg__cmd{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Courier New",monospace;font-size:12px;line-height:18px;word-break:break-all;user-select:text;padding:6px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}',
].join('\n');

const settingsCssTag = 'dsh-whale-girl/settings.css';
/** 注入设置页 CSS（只注入一次；与宠物页面 injectCss 同一套 data-plugin-css 去重） */
function injectSettingsCss(): void {
  if (typeof document === 'undefined') return;
  if (document.querySelector('style[data-plugin-css="' + settingsCssTag + '"]') !== null) return;
  const tag = document.createElement('style');
  tag.dataset.plugin = 'dsh-whale-girl';
  tag.dataset.pluginCss = settingsCssTag;
  tag.textContent = SETTINGS_CSS;
  document.head.appendChild(tag);
}

/** 选择器浮层里的一行：跟随当前对话 / 服务商分组头 / 模型 / 该服务商没有可用模型 */
type ModelRow =
  | { kind: 'follow'; key: string }
  | { kind: 'group'; key: string; name: string }
  | { kind: 'none'; key: string }
  | { kind: 'model'; key: string; provider: string; model: { id: string; name: string } };

export const zh = {
  nav: '桌宠配置',
  intro: '管理多个桌宠：每个宠物可独立设置大小与位置（保存后即时生效）。',
  // 卡片标题 + 卡片级说明（说明都进问号，不再占一行小字）
  petCardTitle: '宠物配置',
  petCardHint:
    '每只宠物独立配置：名字 / 大小 / 显示位置 / 位置 / 偏移 / 四个功能开关。改完点最下面的「保存」即时生效。',
  globalTitle: '全局开关',
  globalHint:
    '所有宠物共用（pet pack 可在自己种类文件里单独覆盖）。这几个开关只改本地状态，随「保存」整包写入用户配置（不做即时写入）；系统通知在保存后即时重读，无需刷新页面。',
  cornerHint: '宠物贴着屏幕的哪个角（桌面端按各自显示器的工作区算）。',
  marginXHint: '距所选角落的水平距离（px），可为任意数字。',
  marginYHint: '距所选角落的垂直距离（px），可为任意数字。',
  // 「/」命令菜单里的行标题（图标由 app.ts 经 command-faces.ts 补上）
  'cmd.chat': '对话',
  'cmd.pet': '桌宠',
  'cmd.balance': '余额',
  petsLabel: '宠物列表',
  add: '添加宠物',
  remove: '删除',
  confirmRemove: '确定删除宠物「{id}」吗？',
  confirmTitle: '确认操作',
  cancel: '取消',
  ok: '知道了',
  atLeastOne: '至少保留一个宠物。',
  emptyPets: '暂无宠物，点击「添加宠物」创建。',
  sizeLabel: '大小（宽度 px）',
  sizeHint: '高度自动 = 宽度 × 9/16。',
  nameLabel: '名字',
  nameHint: '显示名：鼠标悬浮宠物时弹出，也会加进 AI 人设（你的名字是 X）。可重复，留空按宠物 id 处理。',
  balanceEnabled: '余额功能',
  balanceEnabledHint: '启用后该宠物触发余额动画并显示余额气泡。',
  whisperEnabled: '碎碎念',
  whisperEnabledHint: '启用后该宠物按周期用 AI 生成一句话并播碎碎念动画（人设与周期在配置文件顶层）。',
  workStatusEnabled: '工作状态联动',
  workStatusEnabledHint:
    '启用后该宠物跟随 DSH 工作状态：思考/工作中/等待确认/完成/出错时自动切对应动画并弹气泡（动画池在配置顶层，仅监听不调用模型）。',
  fixedEnabled: '宠物固定',
  fixedEnabledHint:
    '启用后随机动画不再让宠物自己转向或走开，只播原地待机与随机小动作；右键菜单点播、接口触发、余额/碎碎念/工作状态动画不受影响。',
  displayLabel: '显示位置',
  displayHint: 'web=仅浏览器 / desktop=仅桌面 / both=两者都显示 / none=都不显示',
  'display.web': '仅浏览器',
  'display.desktop': '仅桌面',
  'display.both': '两者都显示',
  'display.none': '都不显示',
  cornerLabel: '位置',
  'corner.top-left': '左上角',
  'corner.top-right': '右上角',
  'corner.bottom-left': '左下角',
  'corner.bottom-right': '右下角',
  marginX: '水平偏移',
  marginY: '垂直偏移',
  save: '保存',
  sync: '同步',
  confirmSync: '确定同步吗？将用项目内置的默认配置（完整字段 + 注释）覆盖用户配置，当前的自定义内容会丢失。',
  corruptTitle: '用户配置已损坏，未保存',
  corruptConfirm: '强行保存',
  corruptBody:
    '用户配置文件解析不了（内容已损坏，不是合法 JSON/JSONC）：{path}。继续保存会按白名单重建这个文件——它里面现有的内容（animations / physics / memes 等自定义字段）会全部丢失。取消 = 不动文件（先去把配置改回合法再保存）；确认 = 强行保存（丢弃文件里现有的内容）。',
  syncHint:
    '「同步」会把项目内置的默认配置（含注释与全部高级字段）写入用户配置文件，覆盖当前自定义内容；之后可直接编辑该文件。注意两点：① 文件一旦生成即为显式覆盖层——插件升级后内置默认的变化不会自动生效（除非再次同步或删除该文件）；② 在本页点「保存」会按白名单重写该文件（字段值保留，但注释会被去掉）。',
  configMeta: '高级配置（文件）',
  configMetaHint:
    '用户配置可覆盖宠物列表 / 动画池 / 播放权重，修改后刷新或重启生效：浏览器端刷新页面，桌面端右键宠物 →「重载配置」（重载全部桌面宠物窗口）；默认配置为完整参考。',
  defaultConfig: '默认配置（只读，完整参考）',
  userConfig: '用户配置（自定义覆盖）',
  animationDir: '动画素材目录（可自定义/扩充动画）',
  memesDir: '表情包目录（可自定义/扩充配图）',
  saved: '已保存，桌宠即时生效。',
  loadError: '加载配置失败',
  loading: '正在加载配置…',
  retry: '重试',
  invalid: '请检查输入：大小需为正数，边距可为任意数字。',
  busy: '保存中…',
  extraPetsHint:
    '另 {n} 只额外宠物由 pet/ 目录文件定义（<名>-config.json + <名>-animation/ + <名>-memes/），它们不在此列表——改文件后浏览器刷新页面、桌面端右键「重载配置」即可生效。',
  notifyToggle: '系统通知',
  notifyToggleHint: '对话完成 / 生成失败 / 权限申请 / 用户选择，在窗口失焦时弹出系统级通知（桌面右下角）。',
  whisperImageToggle: '碎碎念配图',
  whisperImageToggleHint:
    '碎碎念时从表情包池随机抽一张，连同那句话一起显示（图片映射在配置文件顶层 memes）。token：碎碎念本来就每次生成都要调一次模型，配图只是把抽中那张的名称+描述（约 100 字符 / ≈60 token）加进同一次请求，增量可忽略。',
  chatImageToggle: '对话配图',
  chatImageToggleHint:
    '对话时由 AI 按当前语境从表情包池挑一张配图（可不挑；图片映射在配置文件顶层 memes）。token：每条消息都要把整张清单附进请求，当前约 1.1k 字符（≈650 token，约碎碎念配图的 11 倍），并随图片数量线性增长；关掉则一个字符都不附。',
  confineToggle: '抛掷锁定在当前屏幕',
  confineToggleHint:
    '多屏用户：甩出去的宠物只在松手时所在那块屏幕内弹（屏缝当墙，不飞到隔壁屏）；关掉则照常跨屏飞行。只影响桌面模式——浏览器 overlay 本来就只在视口内弹。',
  physicsTitle: '物理（拖拽抛掷手感）',
  voiceTitle: '语音对话',
  voiceHint:
    '识别用本机 SenseVoice（离线免费），合成用 edge-tts。这里改完点「保存语音设置」**立即生效**——语音配置单独存在 voice.json，不参与下面的「保存」。',
  voiceShortcutLabel: '按住说话的快捷键',
  voiceShortcutHint:
    '形如 Alt+V / Ctrl+Shift+Space / F8。按住说话、松开结束；播放中按下可打断。宿主会注册**系统级**热键：DSH 窗口在后台、最小化或被其他应用挡住时也能用（需要 DSH 主程序在运行，仅 Windows）。',
  voiceMicLabel: '麦克风设备',
  voiceMicDefault: '跟随系统默认',
  voiceMicRefresh: '重新检测',
  voiceMicHint:
    '选了就只从这台设备录音。设备名需要先授权麦克风才读得到，点「重新检测」会请求一次权限（不会录音）',
  voiceMicTest: '测试麦克风',
  voiceMicTestStop: '停止测试',
  voiceMicTestHint:
    '点「测试麦克风」后对着麦克风说两三秒话：电平条跟着动 = 设备在正常录入；说完会给结论。测试本身不录音、不发给模型。',
  voiceMicTestOk: '✅ 有声音，设备正常',
  voiceMicTestQuiet: '⚠️ 几乎没声音：检查设备是否选对、系统静音或麦克风被占用',
  voiceMicTestDenied: '麦克风权限被拒绝',
  voiceMicTestNotFound: '选定的麦克风不可用',
  voicePreview: '试听一句',
  voicePreviewLoading: '合成中…',
  voicePreviewPlayed: '已播放',
  voicePreviewHint:
    '会合成一句「主人，我是鲸鱼娘，能听到我吗？」并播出来。如果你看到「已播放 N 秒」却还是没声音，问题在**系统输出设备**（这台机器上有 Voicemeeter / VR / USB 等多个输出端点），不是插件。',
  voiceHideButton: '隐藏麦克风按钮',
  voiceHideButtonHint: '勾选后界面右下角那颗按钮不再显示，只用快捷键说话（快捷键可在上面改）。',
  sightTitle: '看屏幕搭话（主动识屏）',
  sightHint:
    '打开后，我会隔一段时间看一眼屏幕，看到值得说的就冒个气泡。默认关着——你不开，我绝不截图。',
  sightEnabled: '开启主动识屏',
  sightEnabledHint:
    '截图在本机压成约 120 KB 的 JPEG，用**你选的模型**识别（默认跟对话模型一致——选 workbuddy 就花积分，不烧官方 token）。图片只经一次临时中转，调用结束立刻删除；下面的快照是另存的审计副本，随时可查。',
  sightVisionModelLabel: '当前使用模型',
  sightIntervalLabel: '间隔（秒）',
  sightIntervalHint: '最短 15 秒。太频繁既费钱又吵。',
  sightKeepLabel: '快照保留张数',
  sightKeepHint: '存一份给你核对「我看了什么」。0 = 不留，最多 200 张，超了删最旧的。',
  sightSpeak: '顺便念出来',
  sightModeLabel: '观察模式',
  sightModeCompanion: '日常陪聊',
  sightModePlay: '陪玩（盯着战况）',
  sightModeWatch: '只看不说',
  sightModeHint:
    '三种模式只换提示词（间隔、张数、是否朗读等参数都共用）：日常陪聊随口搭话；陪玩盯着战局点评、给具体建议；只看不说只存快照、不调用模型，不打扰也不花钱。',
  sightJitterMinLabel: '间隔随机下限（倍）',
  sightJitterMaxLabel: '间隔随机上限（倍）',
  sightJitterHint:
    '实际间隔 = 基准秒数 × 这个区间里的随机数。0.6~1.6 表示有时 36 秒、有时 96 秒——比固定频率自然。',
  sightMemoryShared: '搭话也写入共享记忆',
  sightMemoryHint: '勾上后她看屏幕说的话也进同一份记忆，跟文字/语音对话连贯（推荐）。',
  sightSpeakHint: '不勾只弹气泡（推荐）；勾上会用语音念，像在耳边说话。',
  sightRunNow: '现在看一眼',
  sightRunning: '正在看…',
  sightRunSpoke: '她说了',
  sightRunSkipped: '这次没说话',
  sightRunFailed: '没看成',
  sightSave: '保存识屏设置',
  sightSaving: '保存中…',
  sightSaved: '已保存',
  sightSnapshots: '已留快照',
  voiceVisionLabel: '语音时主动看屏幕',
  voiceVisionOff: '从不（最省）',
  voiceVisionAuto: '提到才看（推荐）',
  voiceVisionAlways: '每次都看（最贵）',
  voiceVisionHint: '你说「我在干嘛」「看这个」这类话时，她会自己看一眼再回答。auto 档只在话里提到相关词时才看。',
  voiceFramesLabel: '连拍帧数',
  voiceFramesHint: '1 张 = 最省，只能看静态；3~5 张能对比出画面在怎么变化（钱也按张数涨）。',
  voiceGapLabel: '帧间隔（毫秒）',
  voiceGapHint: '太短看不出变化，太长跟不上。700 毫秒适合大多数场景。',
  page_pet: '宠物',
  appsTitle: '应用名单',
  appsHint: '她能打开哪些程序。每行「名字=可执行名」，可自己增减。可执行名是 Start-Process 认的名字（如 WeChat、cloudmusic、msedge）。',
  appsSave: '保存名单',
  appsReload: '重新读取',
  appsSaved: '已保存，立即生效',
  appsFailed: '保存失败',
  wsTitle: '鲸鱼娘工作区',
  wsHint: '这里是她自己的面板：本局进度、开关状态、急停。详细设置在「设置 → 桌宠配置」。',
  wsNoSession: '还没开始本局',
  wsSteps: '步',
  wsSight: '主动识屏',
  wsAutoplay: '允许代打',
  wsOn: '：开',
  wsOff: '：关',
  wsEstop: '急停',
  wsReady: '就绪',
  wsStopped: '已停止',
  wsRun: '跑一轮',
  wsEnd: '结束本局',
  wsRunning: '思考中…',
  wsPlanned: '打算',
  wsSkipped: '跳过',
  wsFailed: '没成功',
  wsNothing: '这局还没记录什么',
  gameTitle: '游戏档案',
  gameHint: '视觉模型只看像素，不可能自己知道「W 是前进」。键位与要点必须写在这里——否则她只能瞎点。',
  gameNameLabel: '游戏名',
  gameNameHint: '填窗口标题里的名字，方便对得上。',
  gameGenreLabel: '类型',
  gameGenreHint: '类型决定默认键位与记忆容量（大战略记得更多）。',
  gameGenreTurn: '回合制',
  gameGenreStrategy: '大战略',
  gameGenreTactics: '战棋',
  gameGenreRpg: 'RPG',
  gameGenreAction: '动作（速度受限）',
  gameGenreCustom: '自定义',
  gameKeysLabel: '键位（每行 动作=键）',
  gameKeysHint: '键名用英文：w a s d space enter esc tab up down left right 0-9。留空的沿用类型预设。',
  gameNotesLabel: '攻略要点（每行一条）',
  gameNotesHint: '写你希望她记住的关键决策，比如「前期优先科研」。',
  gameCapLabel: '本局记忆容量（步）',
  gameCapHint: '留空就用类型预设。玩一局要记多少步决定她记不记得住前面的局势。',
  gameCapPreset: '当前类型预设',
  gameSave: '保存档案',
  gameSaved: '档案已保存',
  gameGuide: '联网查攻略',
  gameGuideBusy: '正在查…',
  gameGuideDone: '查到了',
  gameGuideFailed: '没查到',
  gameNeedName: '先填游戏名再查',
  sessionTitle: '本局进度',
  sessionNone: '还没开始——点「跑一轮」开始记录',
  sessionEnd: '结束本局（记忆压缩）',
  sessionNothing: '这局还没记录什么',
  sessionEnded: '本局已收进记忆',
  page_look: '外观',
  saving: '保存中…',
  saveAll: '保存全部',
  saveAllDone: '全部已保存',
  saveAllHint: '一次写入全部四份配置（宠物 / 语音 / 识屏 / 代打），与当前在哪一页无关。',
  page_voice: '语音',
  page_sight: '看屏幕',
  page_play: '代打',
  page_more: '存储',
  page_log: '对话记录',
  chatlogTitle: '对话记录（只给你看）',
  chatlogHint:
    '完整来往，包括被拆出去的动作/神态（气泡里只保留台词）。和记忆分开：不参与模型上下文，只供随时翻阅。',
  chatlogRefresh: '刷新',
  chatlogExport: '导出',
  chatlogClear: '清空',
  chatlogClearConfirm: '清空这只桌宠的对话记录？记忆不受影响，但记录不可恢复（建议先导出）。',
  chatlogCleared: '已清空',
  chatlogEmpty: '还没有记录。聊几句就会出现在这里。',
  chatlogLoading: '加载中…',
  chatlogLoadFailed: '加载失败，稍后再试',
  chatlogLoadMore: '加载更早',
  playTitle: '代打（自己玩游戏）',
  playHint:
    '开启后她会看屏幕、决定下一步操作，并且**真的按下去**。默认空跑：只打印打算做什么，不动你的键鼠。',
  playEnabled: '允许代打',
  playEnabledHint: '总开关。关着时「跑一轮」也不会有任何动作。',
  playOn: '已允许',
  playOff: '未允许',
  playDryRun: '空跑模式',
  playDryHint: '开着只记录「打算做什么」，不真的按键。建议先空跑几轮确认判断合理。',
  playDryOn: '空跑（安全）',
  playDryOff: '真注入（危险）',
  playEstopKey: '急停键',
  playEstopHint: '随时按这个键立刻撒手。F12 最安全（游戏中几乎不占用）。',
  playEstopState: '急停状态',
  playEstopReady: '就绪',
  playEstopStopped: '已停止',
  playEstopResumeHint: '停止后会一直停着，必须点「恢复」才会再动——这是故意的。',
  playResume: '恢复（我允许她继续）',
  playWindows: '允许动手的窗口',
  playWindowsHint:
    '每行一个窗口标题（包含即可匹配）。前台窗口不匹配时一律拒绝——防止她把按键打进微信或浏览器。留空 = 不限制（不推荐）。',
  playCheckWindow: '看看现在前台是什么',
  playAddWindow: '把当前前台加入白名单',
  playPickWindow: '从运行中的窗口选择…',
  playRefreshWindows: '刷新窗口列表',
  playVisionModel: '代打用的识图模型',
  playVisionFollow: '跟随对话模型（默认）',
  playVisionPickModel: '选择模型…',
  playVisionHint:
    '对话模型如果偏重推理，一轮会很慢（实测 45~60 秒，还可能只想不答）。代打建议单独选一个「快、支持图片」的模型；留空 = 跟随对话模型。',
  playSave: '保存代打设置',
  playStart: '开始陪玩（她自己一局一局玩下去）',
  playStop: '停止陪玩',
  playLoopOn: '陪玩进行中：右下角有状态气泡；动一下键鼠或按急停键会停',
  playRunNow: '跑一轮',
  playRunning: '思考中…',
  playLog: '动作日志（最近 30 条）',
  playLogEmpty: '还没有记录。点「跑一轮」试一次空跑。',
  voiceNameLabel: '音色',
  voiceNameHint: 'edge-tts 的音色名，默认 zh-CN-XiaoyiNeural（晓伊）',
  voiceSave: '保存语音设置',
  voiceSaving: '保存中…',
  voiceHotkeyRunning: '全局热键正在运行（{{shortcut}}）：DSH 在后台、最小化或被其他应用挡住时也能用',
  voiceHotkeyFailed: '全局热键还没生效：{{message}}（页面有焦点时快捷键仍然可用）',
  personaTitle: '人设（自定义）',
  personaHint:
    '留空 = 用配置文件里的默认人设。这里写的内容会覆盖 main 条目的 whisperPrompt（碎碎念与对话共用同一份人设）。',
  personaPlaceholder: '你是一只住在主人桌面上的鲸鱼娘……',
  personaSave: '保存人设',
  personaSaved: '人设已保存（下一句生效，不用重启）',
  personaUsingFile: '当前使用：你自己写的人设（persona.json）',
  personaUsingConfig: '当前使用：配置文件里的默认人设',
  memoryTitle: '对话记忆（导入 / 导出）',
  memoryHint:
    '当前 {{count}} 条。支持粘贴 JSON 数组（[{role,content}]）、{messages:[…]}，或「我：… / 你：…」一行一句的纯文本；导入会按时间合并去重。注意：每次对话只带最近 N 轮（设置里的「对话记忆轮数」）。',
  memoryPlaceholder: '把手机端导出的聊天记录粘贴到这里，或点「选择文件」…',
  memoryImport: '导入记忆',
  memoryExport: '导出记忆',
  memoryClear: '清空记忆',
  memoryEmpty: '先粘贴内容或选择文件',
  memoryImported: '导入完成：新增 {{added}} 条，共 {{total}} 条',
  memoryCleared: '已清空',
  memoryClearConfirm: '确定要清空这只桌宠的全部对话记忆吗？清空后不可恢复（建议先导出）。',
  memoryExportFailed: '导出失败，稍后再试',
  voiceSaved: '已保存，快捷键与全局热键立即生效',  physicsHint:
    '全局默认，所有宠物共用（pet pack 可在自己种类文件里单独覆盖）；随「保存」写入用户配置（不做即时写入）。浏览器保存后即时生效，桌面端由保存重载宠物窗口后生效。',
  'physics.gravity': '重力 gravity',
  'physics.gravityHint': 'px/s²，越大落得越快；0 = 无重力（抛出去匀速直线飞）',
  'physics.restitution': '弹性 restitution',
  'physics.restitutionHint': '0~1，碰壁 / 落地反弹保留的速度比例（1 = 完全弹性，0 = 撞上即停）',
  'physics.groundFriction': '地面摩擦 groundFriction',
  'physics.groundFrictionHint': '/s，落地后水平速度的衰减率；0 = 冰面不减速',
  'physics.throwPower': '总力度 throwPower',
  'physics.throwPowerHint': '> 0，弹簧跟手与甩出初速的整体倍率（1 = 默认；越大越跟手、甩得越猛）',
  physicsCeilingBounce: '顶部反弹 ceilingBounce',
  physicsCeilingBounceHint: '关掉后抛掷可飞出屏幕顶部（重力仍会把它拉回来）',
  physicsPetCollision: '宠物互撞 petCollision',
  physicsPetCollisionHint: '飞行中的宠物撞到别的宠物按动量守恒弹开（质量 ∝ 尺寸²）',
  invalidPhysics: '请检查物理参数：重力 / 地面摩擦 ≥ 0，弹性 0~1，总力度 > 0。',
  fontTitle: '外观与字体',
  fontHint:
    '字体种类作用于现在用软糖体的全部文字：宠物气泡、悬浮提示、对话窗、得分弹窗；字号只作用于宠物气泡与悬浮提示（对话窗与得分弹窗的字号不变）。全局默认，所有宠物共用（pet pack 可在自己种类文件里单独覆盖）；随「保存」写入用户配置，浏览器保存后即时生效，桌面端由保存重载宠物窗口后生效。',
  fontFamilyLabel: '字体',
  fontFamilyHint:
    '「软糖体（内置）」随插件提供；其余为系统字体，机器上没装时自动回退到字体栈里的下一个（不会空白或报错）。',
  fontSizeLabel: '字号（px）',
  fontSizeHint: '气泡正文字号；悬浮提示与气泡内的小字按既有比例派生。范围 4~200。',
  fontFollowToggle: '字号随宠物大小缩放',
  fontFollowToggleHint:
    '开启（默认）：宠物调大时字号等比放大，462 宽时正好是上面设定的字号；关闭：字号恒定，不随宠物大小变化。',
  invalidFont: '请检查字体设置：字体需在下拉列表内，字号需为 4~200 的数字。',
  'font.candy': '软糖体（内置）',
  'font.yahei': '微软雅黑 / 苹方',
  'font.youyuan': '幼圆',
  'font.kaiti': '楷体',
  'font.simsun': '宋体',
  'font.comic': '漫画体',
  'font.system': '系统默认',
  modelTitle: 'AI 模型与对话上下文',
  modelHint:
    '这一个模型同时用于文字对话、语音对话、看屏幕搭话与代打——它们都是同一个「她」。选「跟随当前对话」= 用你当前对话正在用的那个（默认）。选项与 DSH 的模型选择器同源，由宿主实时提供。',
  modelSharedHint: '文字对话 / 语音对话 / 看屏幕搭话 / 代打都用这一个模型，改一处全部跟着变。',
  modelFollow: '跟随当前对话',
  modelSearch: '搜索模型…',
  modelEmpty: '没有匹配的模型。',
  modelNoModels: '没有可用的模型。',
  modelLoading: '正在刷新模型列表…',
  modelTriggerAria: '选择模型，当前 {model}',
  modelUnknown: '（当前配置，不在列表中）',
  modelNone: '该服务商没有可用模型',
  whisperModelLabel: '碎碎念模型',
  chatModelLabel: '对话模型',
  modelFieldHint: '选「跟随当前对话」= 用当前对话的模型；指定了但调用失败会自动回落到当前对话的模型重试一次。',
  invalidModel: '请检查模型设置：服务商与模型要么都选，要么都留空（跟随当前对话）。',
  modelCatalogFailed: '模型列表加载失败（刷新页面可重试）；当前配置值仍会原样保留。',
  chatMemory: '对话历史条数',
  chatMemoryHint:
    '每次对话请求携带的最近历史轮数（1 轮 = 1 问 1 答；0 = 不带历史，每句都是全新对话）。对话记忆本身全存不删，此值只决定截多少进上下文——越大越记得住，也越费 token。全局默认，所有宠物共用（pet pack 可在自己种类文件里单独覆盖）。',
  invalidChatMemory: '请检查对话历史条数：需为 ≥ 0 的数字。',
  chatImageLimit: '对话配图张数上限',
  chatImageLimitHint:
    '对话时发给模型的表情包清单最多几张（「前 N 张」= 配置里写在前面的那 N 条，想让哪几张优先被发出去就把顺序往前挪）。整张清单是每条消息都要附的，token 随张数线性增长——张数一多就是纯烧钱，限制成前 N 张，模型只从这几张里挑。0 = 不限制（全部发）。内置默认 10。全局默认，所有宠物共用（pet pack 可在自己种类文件里覆盖）。只影响对话选图：碎碎念只带抽中的那一张。',
  invalidChatImageLimit: '请检查对话配图张数上限：需为 ≥ 0 的数字（0 = 不限制）。',
  notifyTest: '测试弹窗',
  notifyTestOk: '测试通知已发送，请查看桌面右下角。',
  notifyDenyUnsupported: '当前环境不支持系统通知（浏览器无 Notification API）。',
  notifyDenyBlocked: '通知权限已被浏览器标记为「阻止」。',
  notifyDenyRejected: '你在权限询问弹窗中选择了「阻止」。',
  notifyDenyError: '申请权限时出错',
  notifyGuide: '引导：点击地址栏左侧 🔒/ⓘ →「网站设置」→「通知」→ 改为「允许」，刷新页面后重试。',
  storageTitle: '卸载与存储',
  storageHint: '插件在本机落下的全部位置。删缓存不影响使用（会自动重下/重建）；删「插件用户数据」会丢配置与对话记忆。',
  'storage.userData':
    '插件用户数据：自定义配置 main-config.jsonc、对话记忆 memory.json、自定义动画素材 main-animation/、文件宠物 pet/',
  'storage.electron': '桌面宠物用的 Electron 运行时（体积较大；删除后下次启用桌面模式会自动重新下载）',
  'storage.desktopCache': '桌面宠物窗口的缓存与主屏缩放缓存（可删，会自动重建）',
  'storage.electronCache': 'Electron 安装包下载缓存（可删，需要时会重新下载）',
  'storage.package': '插件本体（由 DSH 管理，用下面的卸载命令移除，不要手删）',
  storageMissing: '（尚未创建）',
  uninstallTitle: '卸载方法',
  uninstallStep1: '1. 先退出 DSH（桌面宠物随之退出）；不要在桌宠运行时删除上面的文件。',
  uninstallStep2: '2. 卸载插件本体（终端执行，会同时从 profile 的 bundle 层移除）：',
  uninstallStep3:
    '3. 按需删除上面的位置：缓存类删了无影响；「插件用户数据」删了会丢配置与对话记忆（想保留就先备份其中的 main-config.jsonc）。',
  uninstallCmd: 'dsh plugin --profile {profile} remove dsh-whale-girl',
};

export const en = {
  nav: 'Pet Config',
  intro: 'Manage multiple pets: each pet has its own size and position (applies instantly after saving).',
  // Card titles + card-level help (all hints move into the "?" bubble)
  petCardTitle: 'Pet',
  petCardHint:
    'Per-pet settings: name / size / display / corner / offsets / the four feature switches. Click "Save" at the bottom to apply instantly.',
  globalTitle: 'Global switches',
  globalHint:
    'Shared by every pet (a pet pack may override them in its own kind file). These switches only change local state and are written to the user config on "Save" (never written immediately); system notifications re-read right after saving, no page refresh needed.',
  cornerHint: 'Which screen corner the pet sticks to (per-monitor work area in desktop mode).',
  marginXHint: 'Horizontal distance from the chosen corner (px); any number.',
  marginYHint: 'Vertical distance from the chosen corner (px); any number.',
  // Row titles in the "/" command menu (icons are added by app.ts)
  'cmd.chat': 'Chat',
  'cmd.pet': 'Pet',
  'cmd.balance': 'Balance',
  petsLabel: 'Pets',
  add: 'Add pet',
  remove: 'Remove',
  confirmRemove: 'Delete pet "{id}"?',
  confirmTitle: 'Confirm action',
  cancel: 'Cancel',
  ok: 'Got it',
  atLeastOne: 'Keep at least one pet.',
  emptyPets: 'No pets yet — click "Add pet" to create one.',
  sizeLabel: 'Size (width px)',
  sizeHint: 'Height is automatic = width × 9/16.',
  nameLabel: 'Name',
  nameHint:
    'Shown on hover and added to AI personas ("your name is X"). Duplicates allowed; empty falls back to the pet id.',
  balanceEnabled: 'Balance',
  balanceEnabledHint: 'When enabled, this pet plays balance animations and shows the balance bubble.',
  whisperEnabled: 'Whisper',
  whisperEnabledHint:
    'When enabled, this pet periodically generates a line via AI and plays the whisper animation (persona & interval live in the top-level config).',
  workStatusEnabled: 'Work status',
  workStatusEnabledHint:
    'When enabled, this pet follows DSH work state: thinking / working / waiting / done / error switch animations and show bubbles (pool in top-level config; listening only, no model calls).',
  fixedEnabled: 'Pin in place',
  fixedEnabledHint:
    'When enabled, the random chain no longer turns this pet or walks it away — only idle and in-place actions play. Right-click picks, API triggers and balance / whisper / work-status animations are unaffected.',
  displayLabel: 'Display',
  displayHint: 'web = browser only / desktop = desktop only / both = both / none = neither',
  'display.web': 'Browser only',
  'display.desktop': 'Desktop only',
  'display.both': 'Both',
  'display.none': 'Neither',
  cornerLabel: 'Position',
  'corner.top-left': 'Top-left',
  'corner.top-right': 'Top-right',
  'corner.bottom-left': 'Bottom-left',
  'corner.bottom-right': 'Bottom-right',
  marginX: 'Horizontal offset',
  marginY: 'Vertical offset',
  save: 'Save',
  sync: 'Sync',
  confirmSync:
    'Sync? This overwrites the user config with the bundled default config (all fields + comments); current customizations are lost.',
  corruptTitle: 'User config is corrupted — not saved',
  corruptConfirm: 'Save anyway',
  corruptBody:
    'The user config file cannot be parsed (corrupted, not valid JSON/JSONC): {path}. Saving now rebuilds it from the whitelist — everything currently in that file (animations / physics / memes …) will be lost. Cancel = leave the file untouched (fix it and save again); Confirm = save anyway (discard what is in the file).',
  syncHint:
    '"Sync" writes the bundled default config (comments + every advanced field included) to the user config file, overwriting your current customizations; the file is then directly editable. Two caveats: (1) once created, that file is an explicit override layer — later changes to the bundled defaults will not take effect automatically (until you sync again or delete the file); (2) clicking "Save" on this page rewrites the file from a whitelist — field values are kept, comments are dropped.',
  configMeta: 'Advanced (files)',
  configMetaHint:
    'User config may override pets / animation pools / weights — refresh or restart to apply: refresh the page in the browser, or right-click a desktop pet → "Reload config" (rebuilds every desktop pet window). The default config is the complete reference.',
  defaultConfig: 'Default config (read-only, complete reference)',
  userConfig: 'User config (custom overrides)',
  animationDir: 'Animation assets dir (add/customize animations here)',
  memesDir: 'Meme images dir (add/customize images here)',
  saved: 'Saved — the pets updated instantly.',
  loadError: 'Failed to load config',
  loading: 'Loading config…',
  retry: 'Retry',
  invalid: 'Check your input: size must be positive; margins can be any number.',
  busy: 'Saving…',
  extraPetsHint:
    '{n} extra pet(s) are file-defined in the pet/ directory (<name>-config.json + <name>-animation/ + <name>-memes/). They are not in this list — after editing the files, refresh the page (browser) or right-click a desktop pet → "Reload config".',
  notifyToggle: 'System notifications',
  notifyToggleHint:
    'OS-level toasts (bottom-right of the desktop) for conversation completion, failures, permission requests, and questions — only while this window is unfocused.',
  whisperImageToggle: 'Whisper images',
  whisperImageToggleHint:
    'Attach one random meme from the pool to each whisper line (image mapping lives in the top-level `memes` config field). Tokens: a whisper already calls the model every cycle, so the image only appends the name + description of that one meme (~100 chars / ~60 tokens) to the same request — negligible.',
  chatImageToggle: 'Chat images',
  chatImageToggleHint:
    'Let the AI pick one meme from the pool that fits the current context (optional; mapping lives in the top-level `memes` config field). Tokens: every message carries the whole catalog — currently ~1.1k chars (~650 tokens, about 11x the whisper case) and growing with the number of images; turning this off appends nothing at all.',
  confineToggle: 'Lock throws to the current screen',
  confineToggleHint:
    'Multi-monitor: a thrown pet bounces only inside the screen it was released on (screen seams act as walls, so it never flies to the neighbouring monitor); turn this off to let it cross screens as usual. Desktop only — the browser overlay always bounces inside the viewport anyway.',
  physicsTitle: 'Physics (drag & throw feel)',
  voiceTitle: 'Voice chat',
  voiceHint:
    'Recognition uses the on-device SenseVoice model (offline, free); speech uses edge-tts. Changes here take effect immediately via "Save voice settings" — voice config lives in voice.json and is not part of the main Save below.',
  voiceShortcutLabel: 'Push-to-talk shortcut',
  voiceShortcutHint:
    'Such as Alt+V / Ctrl+Shift+Space / F8. Hold to talk, release to finish; press again while speaking to interrupt. The host registers a system-wide hotkey, so it also works while DSH is in the background, minimized, or covered by another app (DSH must be running; Windows only).',
  voiceMicLabel: 'Microphone',
  voiceMicDefault: 'Follow system default',
  voiceMicRefresh: 'Rescan',
  voiceMicHint:
    'Recording uses only this device. Device names require microphone permission — Rescan asks once (it does not record)',
  voiceMicTest: 'Test microphone',
  voiceMicTestStop: 'Stop test',
  voiceMicTestHint:
    'Click "Test microphone" and speak for two or three seconds: a moving level bar means the device records. A verdict follows. The test does not record or send anything.',
  voiceMicTestOk: '✅ Sound detected — device works',
  voiceMicTestQuiet: '⚠️ Almost silent: check the device, system mute, or another app holding the mic',
  voiceMicTestDenied: 'Microphone permission denied',
  voiceMicTestNotFound: 'Selected microphone unavailable',
  voicePreview: 'Play a sample',
  voicePreviewLoading: 'Synthesizing…',
  voicePreviewPlayed: 'Played',
  voicePreviewHint:
    'Synthesizes and plays one sample sentence. If it says "Played N s" but you hear nothing, the problem is your **system output device** (this machine exposes Voicemeeter / VR / USB endpoints), not the plugin.',
  voiceHideButton: 'Hide the microphone button',
  voiceHideButtonHint: 'When checked, the floating button disappears; you talk via the shortcut only (configurable above).',
  sightTitle: 'Screen awareness (proactive)',
  sightHint:
    'When enabled, I peek at your screen every so often and pop a bubble if something is worth saying. Off by default — I never screenshot unless you turn it on.',
  sightEnabled: 'Enable screen awareness',
  sightEnabledHint:
    'The screenshot is compressed locally to ~120 KB JPEG and recognised by **the model you picked** (defaults to your chat model — pick workbuddy and it spends credits, not official tokens). The image passes through one temporary hop that is deleted right after the call; the snapshot below is a separate audit copy you can inspect anytime.',
  sightVisionModelLabel: 'Model in use',
  sightIntervalLabel: 'Interval (seconds)',
  sightIntervalHint: 'Minimum 15s. Shorter is noisy and costs more.',
  sightKeepLabel: 'Snapshots to keep',
  sightKeepHint: 'A local copy so you can audit what I saw. 0 = keep none, max 200, oldest dropped first.',
  sightSpeak: 'Speak it aloud',
  sightModeLabel: 'Observation mode',
  sightModeCompanion: 'Companion',
  sightModePlay: 'Co-op (reads the fight)',
  sightModeWatch: 'Observe silently',
  sightModeHint:
    'The three modes only swap the prompt (interval, frames, speak and other settings are shared): Companion chats casually; Co-op reads the match and gives concrete advice; Observe silently only saves snapshots without calling the model, so it costs nothing and never interrupts.',
  sightJitterMinLabel: 'Jitter lower bound (×)',
  sightJitterMaxLabel: 'Jitter upper bound (×)',
  sightJitterHint:
    'Actual delay = base seconds × a random factor in this range. 0.6–1.6 means sometimes 36s, sometimes 96s — more natural than a fixed rate.',
  sightMemoryShared: 'Write into shared memory',
  sightMemoryHint:
    'When checked, what she says about the screen enters the same memory as text/voice chat, so she stays coherent (recommended).',
  sightSpeakHint: 'Unchecked = bubble only (recommended). Checked = also read aloud.',
  sightRunNow: 'Look now',
  sightRunning: 'Looking…',
  sightRunSpoke: 'She said',
  sightRunSkipped: 'Nothing to say this time',
  sightRunFailed: 'Could not look',
  sightSave: 'Save screen settings',
  sightSaving: 'Saving…',
  sightSaved: 'Saved',
  sightSnapshots: 'Snapshots kept',
  voiceVisionLabel: 'Look at screen during voice chat',
  voiceVisionOff: 'Never (cheapest)',
  voiceVisionAuto: 'When mentioned (recommended)',
  voiceVisionAlways: 'Every turn (priciest)',
  voiceVisionHint: 'When you say things like "what am I doing" or "look at this", she peeks first and then answers. Auto only looks when the words suggest it.',
  voiceFramesLabel: 'Burst frames',
  voiceFramesHint: '1 = cheapest, a single still; 3–5 lets her compare how the screen changes (cost scales with frames).',
  voiceGapLabel: 'Frame gap (ms)',
  voiceGapHint: 'Too short hides motion, too long misses it. 700 ms fits most cases.',
  page_pet: 'Pet',
  appsTitle: 'App name list',
  appsHint: 'Which programs she can open. One "name=executable" per line; add or remove freely. Use the name Start-Process accepts (e.g. WeChat, cloudmusic, msedge).',
  appsSave: 'Save list',
  appsReload: 'Reload',
  appsSaved: 'Saved, effective immediately',
  appsFailed: 'Save failed',
  wsTitle: 'Whale Girl workspace',
  wsHint: 'Her own panel: session progress, toggles, e-stop. Detailed settings live in Settings → Pet configuration.',
  wsNoSession: 'No session yet',
  wsSteps: 'steps',
  wsSight: 'Screen awareness',
  wsAutoplay: 'Autoplay allowed',
  wsOn: ': on',
  wsOff: ': off',
  wsEstop: 'E-stop',
  wsReady: 'ready',
  wsStopped: 'stopped',
  wsRun: 'Run one step',
  wsEnd: 'End session',
  wsRunning: 'Thinking…',
  wsPlanned: 'Plan',
  wsSkipped: 'Skipped',
  wsFailed: 'Failed',
  wsNothing: 'Nothing recorded this session',
  gameTitle: 'Game profile',
  gameHint: 'A vision model sees pixels only — it cannot know W means forward. Write the keys and notes here, or she will just click blindly.',
  gameNameLabel: 'Game name',
  gameNameHint: 'Use the name in the window title so it can be matched.',
  gameGenreLabel: 'Genre',
  gameGenreHint: 'Genre decides preset keys and memory capacity (grand strategy remembers more).',
  gameGenreTurn: 'Turn-based',
  gameGenreStrategy: 'Grand strategy',
  gameGenreTactics: 'Tactics',
  gameGenreRpg: 'RPG',
  gameGenreAction: 'Action (speed-limited)',
  gameGenreCustom: 'Custom',
  gameKeysLabel: 'Keys (action=key per line)',
  gameKeysHint: 'Use English key names: w a s d space enter esc tab up down left right 0-9. Blank entries fall back to the genre preset.',
  gameNotesLabel: 'Strategy notes (one per line)',
  gameNotesHint: 'Things you want her to remember, e.g. "prioritise research early".',
  gameCapLabel: 'Session memory capacity (steps)',
  gameCapHint: 'Leave empty to use the genre preset. How many steps she remembers decides whether she can recall the earlier game state.',
  gameCapPreset: 'Genre preset',
  gameSave: 'Save profile',
  gameSaved: 'Profile saved',
  gameGuide: 'Look up a guide',
  gameGuideBusy: 'Searching…',
  gameGuideDone: 'Found',
  gameGuideFailed: 'Nothing found',
  gameNeedName: 'Enter a game name first',
  sessionTitle: 'This session',
  sessionNone: 'Not started — hit "Run one step" to begin recording',
  sessionEnd: 'End session (compress memory)',
  sessionNothing: 'Nothing recorded in this session',
  sessionEnded: 'Session folded into memory',
  page_look: 'Look',
  saving: 'Saving…',
  saveAll: 'Save all',
  saveAllDone: 'All saved',
  saveAllHint: 'Writes all four config files at once (pet / voice / sight / autoplay), regardless of which tab you are on.',
  page_voice: 'Voice',
  page_sight: 'Sight',
  page_play: 'Autoplay',
  page_more: 'Storage',
  page_log: 'Chat log',
  chatlogTitle: 'Chat log (for your eyes only)',
  chatlogHint:
    'Full exchanges, including the action/expression lines split out of the chat bubble. Separate from memory: never sent to the model, just for browsing.',
  chatlogRefresh: 'Refresh',
  chatlogExport: 'Export',
  chatlogClear: 'Clear',
  chatlogClearConfirm: 'Clear this pet chat log? Memory is unaffected, but the log cannot be recovered (export first).',
  chatlogCleared: 'Cleared',
  chatlogEmpty: 'No entries yet. Chat a little and it will show up here.',
  chatlogLoading: 'Loading…',
  chatlogLoadFailed: 'Failed to load, try again later',
  chatlogLoadMore: 'Load older',
  playTitle: 'Autoplay (plays games itself)',
  playHint:
    'When enabled she looks at the screen, decides the next action, and **actually presses it**. Dry run is on by default: it only prints the plan.',
  playEnabled: 'Allow autoplay',
  playEnabledHint: 'Master switch. When off, "Run one step" performs no action at all.',
  playOn: 'Allowed',
  playOff: 'Not allowed',
  playDryRun: 'Dry run',
  playDryHint: 'Only records what she would do; never touches your input. Run a few dry rounds first.',
  playDryOn: 'Dry run (safe)',
  playDryOff: 'Real injection (risky)',
  playEstopKey: 'Emergency stop key',
  playEstopHint: 'Press anytime to take over instantly. F12 is safest (rarely used by games).',
  playEstopState: 'E-stop state',
  playEstopReady: 'Ready',
  playEstopStopped: 'Stopped',
  playEstopResumeHint: 'Stays stopped until you explicitly resume — that is deliberate.',
  playResume: 'Resume (I allow her to continue)',
  playWindows: 'Windows where she may act',
  playWindowsHint:
    'One window title per line (substring match). Any mismatch refuses the action — prevents typing into chat apps. Empty = no restriction (not recommended).',
  playCheckWindow: 'What is in front right now?',
  playAddWindow: 'Add the front window to the allowlist',
  playPickWindow: 'Pick a running window…',
  playRefreshWindows: 'Refresh windows',
  playVisionModel: 'Vision model for autoplay',
  playVisionFollow: 'Follow chat model (default)',
  playVisionPickModel: 'Pick a model…',
  playVisionHint:
    'A heavy reasoning chat model makes each round slow (45–60 s measured, sometimes thinking without an answer). Pick a fast image-capable model for autoplay; empty = follow the chat model.',
  playSave: 'Save autoplay settings',
  playStart: 'Start playing (round after round)',
  playStop: 'Stop playing',
  playLoopOn: 'Autoplay running — status pill at bottom-right; any input or the estop key stops it',
  playRunNow: 'Run one step',
  playRunning: 'Thinking…',
  playLog: 'Action log (last 30)',
  playLogEmpty: 'No entries yet. Hit "Run one step" for a dry round.',
  voiceNameLabel: 'Voice',
  voiceNameHint: 'edge-tts voice name; default zh-CN-XiaoyiNeural',
  voiceSave: 'Save voice settings',
  voiceSaving: 'Saving…',
  voiceHotkeyRunning: 'Global hotkey is running ({{shortcut}}): works while DSH is in the background, minimized, or covered',
  voiceHotkeyFailed: 'Global hotkey is not active: {{message}} (the shortcut still works while this page has focus)',
  personaTitle: 'Persona (custom)',
  personaHint:
    'Empty = use the default persona from the config file. What you write here overrides the main entry whisperPrompt (shared by idle chatter and chat).',
  personaPlaceholder: 'You are a whale girl living on the master desktop…',
  personaSave: 'Save persona',
  personaSaved: 'Persona saved (applies to the next reply, no restart)',
  personaUsingFile: 'In use: your custom persona (persona.json)',
  personaUsingConfig: 'In use: the default persona from the config file',
  memoryTitle: 'Chat memory (import / export)',
  memoryHint:
    '{{count}} messages. Paste a JSON array ([{role,content}]), a {messages:[…]} object, or plain lines like "Me: … / You: …". Imports are merged and de-duplicated by time. Note: each chat only carries the most recent N rounds (the chat memory rounds setting).',
  memoryPlaceholder: 'Paste the chat export from your phone here, or choose a file…',
  memoryImport: 'Import memory',
  memoryExport: 'Export memory',
  memoryClear: 'Clear memory',
  memoryEmpty: 'Paste something or choose a file first',
  memoryImported: 'Imported: {{added}} added, {{total}} total',
  memoryCleared: 'Cleared',
  memoryClearConfirm: 'Clear all chat memory for this pet? This cannot be undone (export first).',
  memoryExportFailed: 'Export failed, try again later',
  voiceSaved: 'Saved — the shortcut and global hotkey apply immediately',
  physicsHint:
    'Global default, shared by every pet (a pet pack may override it in its own kind file); written to the user config on "Save" (never written immediately). Applies instantly in the browser; on the desktop it applies once Save reloads the pet windows.',
  'physics.gravity': 'Gravity',
  'physics.gravityHint': 'px/s² — the higher, the faster it falls; 0 = weightless (flies straight forever)',
  'physics.restitution': 'Bounciness',
  'physics.restitutionHint':
    '0–1, speed kept when bouncing off a wall or the floor (1 = perfectly elastic, 0 = stops dead)',
  'physics.groundFriction': 'Ground friction',
  'physics.groundFrictionHint': 'per second, horizontal damping while on the ground; 0 = frictionless ice',
  'physics.throwPower': 'Throw power',
  'physics.throwPowerHint':
    '> 0, overall multiplier for spring tracking and release speed (1 = default; higher = tighter tracking, harder throws)',
  physicsCeilingBounce: 'Ceiling bounce',
  physicsCeilingBounceHint:
    'Turn this off to let a throw fly out through the top of the screen (gravity still pulls it back)',
  physicsPetCollision: 'Pet collisions',
  physicsPetCollisionHint: 'A flying pet bounces off the others with momentum conservation (mass ∝ size²)',
  invalidPhysics: 'Check the physics values: gravity / ground friction ≥ 0, bounciness 0–1, throw power > 0.',
  fontTitle: 'Appearance & font',
  fontHint:
    'The family applies to every place that currently uses the candy font: pet bubble, hover tooltip, chat popup, score popup. The size applies only to the pet bubble and the hover tooltip (chat and score popups keep their own size). Global default, shared by every pet (a pet pack may override it in its own kind file); written to the user config on "Save" — instant in the browser, and on the desktop it applies once Save reloads the pet windows.',
  fontFamilyLabel: 'Font',
  fontFamilyHint:
    '"Candy (bundled)" ships with the plugin; the others are system fonts. If a font is missing on this machine, it falls back to the next one in the stack (never blank, never an error).',
  fontSizeLabel: 'Font size (px)',
  fontSizeHint:
    'Bubble body text size; the tooltip and the smaller lines inside the bubble scale proportionally. Range 4–200.',
  fontFollowToggle: 'Scale font with pet size',
  fontFollowToggleHint:
    'On (default): the font grows with the pet — at 462 px width it is exactly the size above. Off: the size stays fixed regardless of pet size.',
  invalidFont:
    'Check the font settings: the family must be in the list and the size must be a number between 4 and 200.',
  'font.candy': 'Candy (bundled)',
  'font.yahei': 'Microsoft YaHei / PingFang',
  'font.youyuan': 'YouYuan',
  'font.kaiti': 'KaiTi',
  'font.simsun': 'SimSun',
  'font.comic': 'Comic Sans MS',
  'font.system': 'System default',
  modelTitle: 'AI models & chat context',
  modelHint:
    'This single model drives text chat, voice chat, screen awareness and autoplay — they are the same character. "Follow current conversation" reuses the model your conversation is on (default). Options come from the same source as the DSH model picker, served live by the host.',
  modelSharedHint: 'Text chat, voice chat, screen awareness and autoplay all share this one model — change it once.',
  modelFollow: 'Follow current conversation',
  modelSearch: 'Search models…',
  modelEmpty: 'No matching models.',
  modelNoModels: 'No models available.',
  modelLoading: 'Refreshing model list…',
  modelTriggerAria: 'Select model, current {model}',
  modelUnknown: ' (current config, not in the list)',
  modelNone: 'No models available for this provider',
  whisperModelLabel: 'Whisper model',
  chatModelLabel: 'Chat model',
  modelFieldHint:
    '"Follow current conversation" uses the conversation model; if a chosen model fails, the plugin falls back to the conversation model and retries once.',
  invalidModel:
    'Check the model settings: pick both a provider and a model, or leave both empty (follow the current conversation).',
  modelCatalogFailed:
    'Failed to load the model list (refresh the page to retry); your current values are kept as they are.',
  chatMemory: 'Chat history rounds',
  chatMemoryHint:
    'How many recent rounds each chat request carries (1 round = 1 question + 1 answer; 0 = no history, every message starts fresh). The memory itself keeps everything — this only decides how much goes into the context: higher remembers more and costs more tokens. Global default, shared by every pet (a pet pack may override it in its own kind file).',
  invalidChatMemory: 'Check the chat history rounds: it must be a number ≥ 0.',
  chatImageLimit: 'Chat image limit',
  chatImageLimitHint:
    'How many memes at most are listed to the model during chat ("first N" = the first N you wrote in the config, so move the ones you want sent to the front). That whole list is attached to every message and tokens grow linearly with the count, so a long list is pure burn; capping it to the first N makes the model pick only among those. 0 = no limit (send everything). Built-in default 10. Global default, shared by every pet (a pet pack may override it in its own kind file). Chat only — a whisper carries just the one meme it drew.',
  invalidChatImageLimit: 'Check the chat image limit: it must be a number ≥ 0 (0 = no limit).',
  notifyTest: 'Test notification',
  notifyTestOk: 'Test notification sent — check the bottom-right of your desktop.',
  notifyDenyUnsupported: 'System notifications are not supported in this environment (no Notification API).',
  notifyDenyBlocked: 'Notification permission is blocked by the browser.',
  notifyDenyRejected: 'You chose "Block" in the permission prompt.',
  notifyDenyError: 'Failed to request permission',
  notifyGuide:
    'Guide: click the 🔒/ⓘ icon next to the address bar → Site settings → Notifications → set to "Allow", then refresh and retry.',
  storageTitle: 'Uninstall & storage',
  storageHint:
    'Every location this plugin writes to. Deleting cache folders is harmless (they re-download / rebuild); deleting "plugin user data" loses your config and chat memory.',
  'storage.userData':
    'Plugin user data: custom config main-config.jsonc, chat memory memory.json, custom animation assets main-animation/, file pets pet/',
  'storage.electron':
    'Electron runtime used by the desktop pet (large; re-downloaded automatically the next time desktop mode starts)',
  'storage.desktopCache':
    'Desktop pet window cache and primary-monitor scale cache (safe to delete, rebuilt automatically)',
  'storage.electronCache': 'Electron installer download cache (safe to delete, re-downloaded when needed)',
  'storage.package': 'The plugin itself (managed by DSH — remove it with the command below instead of deleting it)',
  storageMissing: ' (not created yet)',
  uninstallTitle: 'How to uninstall',
  uninstallStep1:
    '1. Quit DSH first (the desktop pet exits with it); do not delete these files while the pet is running.',
  uninstallStep2: '2. Remove the plugin itself (run in a terminal; this also drops it from the profile bundle layer):',
  uninstallStep3:
    '3. Delete the locations above as needed: cache folders are harmless; deleting "plugin user data" loses your config and chat memory (back up main-config.jsonc first if you want to keep it).',
  uninstallCmd: 'dsh plugin --profile {profile} remove dsh-whale-girl',
};

/**
 * 制造「桌宠配置」设置页组件（工厂函数）。
 *
 * 为什么是工厂而非直接定义组件：client 半侧是 __ModuleLoader__ 单文件形态，
 * react 能力不能顶层 import，只能由 DSH 的 require('react') 在运行时注入，
 * 因此把组件依赖作为参数传入，在工厂内制造出可用的组件后再注册进设置页插槽。
 *
 * @param rt        运行时注入的依赖集合
 * @param rt.h      react/jsx-runtime 的 jsx 函数（即 factory 里的 `h`）——
 *                  用于手写 React 元素，如 `h('button', { onClick, children: '保存' })`
 * @param rt.useState react 的 useState hook——管理页面内可变状态
 *                  （宠物列表 / 选中项 / 忙碌 / 保存消息），值变化时自动重渲染
 * @param rt.useRef react 的 useRef hook——「AI 模型」单下拉选择器用它拿触发器/浮层节点
 *                  （浮层定位与"点外面关闭"判定），与宠物页面同一份注入
 * @param rt.t      locale 绑定到本插件的翻译函数（ctx.locale.bind(NS)）——
 *                  取中英文文案，如 `t('nav')` → '桌宠配置' / 'Pet Config'
 * @returns PetConfigSection 组件：即整个「桌宠配置」设置页
 *          （props 仅有 close，由设置页外壳提供，本页当前未使用）
 */
export function makePetConfigSection(rt: {
  h: typeof jsx;
  useState: <T>(init: T) => [T, Dispatch<SetStateAction<T>>];
  // 用 React 命名空间类型而非 typeof：type-only import 的 hook 无法进入声明导出（TS4078）
  useEffect: (effect: ReactNS.EffectCallback, deps?: ReactNS.DependencyList) => void;
  useRef: <T>(initial: T) => ReactNS.MutableRefObject<T>;
  useCallback: typeof ReactNS.useCallback;
  t: (key: string) => string;
}): FunctionComponent<{ close?: () => void }> {
  const { h, useState, useEffect, useRef, useCallback, t } = rt;

  // 设置页样式（只有模型选择器用得上：hover/焦点环/箭头旋转这些伪类行内样式表达不了）
  injectSettingsCss();

  const CORNERS: Corner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
  const cornerLabel = (c: Corner): string => t('corner.' + c);

  const inputClass = 'dsh-whale-girl-cfg__inp';

  /** 等宽字体栈（路径与命令展示用；不引外部字体，走系统栈，避免多拉一份资源） */
  const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Courier New", monospace';

  /** 生成一个未占用的宠物 id（pet-2、pet-3…） */
  const nextId = (list: Pet[]): string => {
    let n = 2;
    for (; ; n++) {
      const id = 'pet-' + n;
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
  const q = (tip: string, end = false): ReturnType<typeof h> =>
    h('i', {
      className: 'dsh-whale-girl-cfg__q' + (end ? ' is-end' : ''),
      'data-tip': tip,
      'aria-label': tip,
      role: 'img',
      children: '?',
    });

  /** 卡片头：标题 + 问号说明（+ 可选右侧动作，由调用方自行 append） */
  const cardHead = (title: string, tip?: string, end = false): ReturnType<typeof h> =>
    h('div', {
      className: 'dsh-whale-girl-cfg__cardHead',
      children: [
        h('span', { key: 't', className: 'dsh-whale-girl-cfg__cardTitle', children: title }),
        tip ? q(tip, end) : null,
      ],
    });

  /** 一个字段：标签（+ 问号）在上、控件在下 */
  const field = (label: string, control: ReturnType<typeof h>, tip?: string, end = false): ReturnType<typeof h> =>
    h('div', {
      className: 'dsh-whale-girl-cfg__field',
      children: [
        h('span', {
          key: 'l',
          className: 'dsh-whale-girl-cfg__flabel',
          children: tip ? [label, q(tip, end)] : label,
        }),
        control,
      ],
    });

  /**
   * 开关的一格：勾选框 + 标题 + 问号。
   * label 为文案键：标题 = t(label)，说明 = t(label + 'Hint')（说明进问号，不再占一行小字）。
   * 说明挂在问号上而不是整格——点标题只切开关，看说明去点问号，两个动作不再抢同一次点击。
   */
  const toggleCell = (
    label: string,
    value: boolean,
    disabled: boolean,
    onToggle: (v: boolean) => void,
    end = false,
  ): ReturnType<typeof h> =>
    h('div', {
      className: 'dsh-whale-girl-cfg__toggle',
      children: [
        h('label', {
          key: 'l',
          children: [
            h('input', {
              key: 'i',
              type: 'checkbox',
              checked: value,
              disabled,
              onChange: (e: ChangeEvent<HTMLInputElement>) => onToggle(e.target.checked),
            }),
            h('span', { key: 't', children: t(label) }),
          ],
        }),
        q(t(label + 'Hint'), end),
      ],
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
  const ModelPicker: FunctionComponent<{
    label: string;
    value: ModelSelection;
    disabled: boolean;
    catalog: ModelCatalogGroup[] | null;
    failed: boolean;
    onChange: (v: ModelSelection) => void;
  }> = (props) => {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    // 高亮行（键盘 ↑↓ 走的就是它；只停在可选项上）
    const [active, setActive] = useState(0);
    // 浮层位置：打开时按触发器实测一次，空间不够就翻到上方（DSH 也是实测 + 视口钳制）
    const [pos, setPos] = useState<null | {
      left: number;
      top?: number;
      bottom?: number;
      width: number;
      maxHeight: number;
    }>(null);
    const rootRef = useRef<HTMLDivElement | null>(null);
    const panelRef = useRef<HTMLDivElement | null>(null);

    const groups = props.catalog ?? [];
    const group = groups.find((g) => g.id === props.value.provider);
    const picked = group?.models.find((m) => m.id === props.value.model);
    const isFollow = props.value.provider === '';
    const triggerLabel = isFollow ? t('modelFollow') : (picked?.name ?? props.value.model);
    // 当前配置不在清单里（服务商下线 / 模型下架）时如实标注，绝不显示成别的模型
    const triggerSub = isFollow ? '' : (group?.name ?? props.value.provider + t('modelUnknown'));

    // 搜索：大小写不敏感的有序子序列（与 DSH 同款语义）
    const q = query.trim().toLowerCase();
    const hit = (text: string): boolean => {
      if (q === '') return true;
      let i = 0;
      for (const ch of text.toLowerCase()) {
        if (ch === q[i]) i += 1;
        if (i >= q.length) return true;
      }
      return false;
    };
    // 行清单：跟随当前对话（只在没搜索词时出现，它不是模型）+ 服务商分组头 + 该组命中的模型
    const rows: ModelRow[] = [];
    if (q === '') rows.push({ kind: 'follow', key: '__follow' });
    for (const g of groups) {
      const models = g.models.filter((m) => hit(m.name + ' ' + m.id));
      if (models.length === 0 && !(q === '' && g.models.length === 0)) continue;
      rows.push({ kind: 'group', key: g.id, name: g.name });
      if (models.length === 0) {
        rows.push({ kind: 'none', key: g.id + '/__none' });
        continue;
      }
      for (const m of models) rows.push({ kind: 'model', key: g.id + '/' + m.id, provider: g.id, model: m });
    }
    // 可选项（分组头 / 提示行不参与键盘走动）
    const selectable = rows.map((r, i) => (r.kind === 'group' || r.kind === 'none' ? -1 : i)).filter((i) => i >= 0);

    const commit = (v: ModelSelection): void => {
      props.onChange(v);
      setOpen(false);
      setQuery('');
    };
    const pick = (row: ModelRow | undefined): void => {
      if (!row) return;
      if (row.kind === 'follow') commit({ provider: '', model: '' });
      else if (row.kind === 'model') commit({ provider: row.provider, model: row.model.id });
    };
    const step = (dir: number): void => {
      if (selectable.length === 0) return;
      const at = selectable.indexOf(active);
      const next = selectable[at < 0 ? 0 : (at + dir + selectable.length) % selectable.length];
      setActive(next);
      panelRef.current?.querySelector('[data-row="' + next + '"]')?.scrollIntoView({ block: 'nearest' });
    };

    useEffect(() => {
      if (!open) return;
      const el = rootRef.current;
      // 定位 + 关闭时机：与 DSH 一致——浮层脱离文档流实测定位，滚动/缩放跟着走，点外面或 Esc 关
      const place = (): void => {
        if (!el) return;
        const r = el.getBoundingClientRect();
        const below = window.innerHeight - r.bottom - 12;
        const above = r.top - 12;
        const width = Math.min(Math.max(r.width, 240), Math.max(200, Math.min(420, window.innerWidth - 16)));
        const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
        const up = below < 240 && above > below;
        setPos(
          up
            ? { left, bottom: window.innerHeight - r.top + 4, width, maxHeight: Math.min(360, above) }
            : { left, top: r.bottom + 4, width, maxHeight: Math.min(360, below) },
        );
      };
      place();
      // 打开即聚焦搜索框（DSH 同样把焦点交给搜索）
      panelRef.current?.querySelector('input')?.focus();
      const onDown = (e: MouseEvent): void => {
        const target = e.target as Node | null;
        if (target && (rootRef.current?.contains(target) === true || panelRef.current?.contains(target) === true)) {
          return;
        }
        setOpen(false);
      };
      const onKey = (e: KeyboardEvent): void => {
        if (e.key === 'Escape') setOpen(false);
      };
      document.addEventListener('mousedown', onDown, true);
      document.addEventListener('keydown', onKey, true);
      window.addEventListener('scroll', place, true);
      window.addEventListener('resize', place);
      return () => {
        document.removeEventListener('mousedown', onDown, true);
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('scroll', place, true);
        window.removeEventListener('resize', place);
      };
    }, [open]);

    const toggle = (): void => {
      if (props.disabled) return;
      if (!open) {
        setQuery('');
        // 打开时高亮停在当前选择上（DSH 打开菜单也是先定位到已选项）
        const at = rows.findIndex(
          (r) => r.kind === 'model' && r.provider === props.value.provider && r.model.id === props.value.model,
        );
        setActive(at >= 0 ? at : 0);
      }
      setOpen(!open);
    };

    const searchRow = h('input', {
      key: 'search',
      type: 'text',
      className: 'dsh-whale-girl-mp__search',
      role: 'searchbox',
      placeholder: t('modelSearch'),
      'aria-label': t('modelSearch'),
      value: query,
      disabled: props.disabled,
      onChange: (e: ChangeEvent<HTMLInputElement>) => {
        setQuery(e.target.value);
        setActive(selectable.length > 0 ? selectable[0] : 0);
      },
      onKeyDown: (e: ReactNS.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          step(1);
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          step(-1);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          pick(rows[active]);
        }
      },
    });

    const rowNode = (row: ModelRow, index: number): ReturnType<typeof h> => {
      if (row.kind === 'group') {
        return h('div', { key: row.key, className: 'dsh-whale-girl-mp__group', children: row.name });
      }
      if (row.kind === 'none') {
        return h('div', { key: row.key, className: 'dsh-whale-girl-mp__status', children: t('modelNone') });
      }
      const checked =
        row.kind === 'follow' ? isFollow : props.value.provider === row.provider && props.value.model === row.model.id;
      return h('button', {
        key: row.key,
        type: 'button',
        role: 'menuitemradio',
        'aria-checked': checked,
        'data-row': index,
        className: 'dsh-whale-girl-mp__item' + (index === active ? ' is-active' : ''),
        disabled: props.disabled,
        onClick: () => pick(row),
        onMouseMove: () => setActive(index),
        children: [
          h('span', {
            key: 'n',
            className: 'dsh-whale-girl-mp__name',
            children: row.kind === 'follow' ? t('modelFollow') : row.model.name,
          }),
          h('span', { key: 'c', className: 'dsh-whale-girl-mp__check', children: checked ? '✓' : '' }),
        ],
      });
    };

    return h('div', {
      ref: rootRef,
      className: 'dsh-whale-girl-mp',
      children: [
        h('button', {
          key: 'trigger',
          type: 'button',
          className: 'dsh-whale-girl-mp__trigger',
          disabled: props.disabled,
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          'aria-label': t('modelTriggerAria').replace('{model}', triggerLabel),
          onClick: toggle,
          children: [
            h('span', { key: 'l', className: 'dsh-whale-girl-mp__label', children: triggerLabel }),
            triggerSub ? h('span', { key: 's', className: 'dsh-whale-girl-mp__sub', children: triggerSub }) : null,
            h('span', { key: 'c', className: 'dsh-whale-girl-mp__chevron' + (open ? ' is-open' : ''), children: '▾' }),
          ],
        }),
        open && pos
          ? h('div', {
              key: 'panel',
              ref: panelRef,
              className: 'dsh-whale-girl-mp__panel',
              role: 'menu',
              'aria-label': props.label,
              style: {
                left: pos.left + 'px',
                top: pos.top === undefined ? undefined : pos.top + 'px',
                bottom: pos.bottom === undefined ? undefined : pos.bottom + 'px',
                width: pos.width + 'px',
                maxHeight: pos.maxHeight + 'px',
              },
              children: [
                searchRow,
                props.catalog === null
                  ? h('div', {
                      key: 'loading',
                      className: 'dsh-whale-girl-mp__status',
                      children: props.failed ? t('modelCatalogFailed') : t('modelLoading'),
                    })
                  : rows.length === 0
                    ? h('div', {
                        key: 'empty',
                        className: 'dsh-whale-girl-mp__status',
                        role: 'status',
                        children: groups.length === 0 ? t('modelNoModels') : t('modelEmpty'),
                      })
                    : h('div', {
                        key: 'list',
                        className: 'dsh-whale-girl-mp__list',
                        role: 'group',
                        children: rows.map(rowNode),
                      }),
              ],
            })
          : null,
      ],
    });
  };

  /**
   * 语音设置卡（独立组件，自带状态）。
   *
   * 为什么单独一块状态而不并进主配置：语音是**主机侧能力**（音色、解释器路径、快捷键），
   * 存在 `$DSH_HOME/dsh-whale-girl/voice.json`，与 `main-config.jsonc` 分开——
   * 那边的逐字段校验失败会让整份配置非法（连宠物都不显示），不该被语音牵连。
   *
   * 所以这里是**即时保存**（点一下就写 voice.json），不参与底部那个「保存」按钮。
   */
  /**
   * 把某个模块的保存函数登记到顶部统一按钮。
null = 注销。
   *
   * 为什么用登记而不是把状态提到父组件：四块配置各自存在不同文件
   * （main-config / voice.json / sight.json / autoplay.json），字段形状也完全不同，
   * 硬提到父组件会让这个组件变成一个巨型 state 容器。登记让每块自己管自己的表单，
   * 只把「怎么保存」交出去。
   */
  type SaveRegistrar = (name: string, fn: (() => Promise<string | null>) | null) => void;

  const VoiceSettingsCard = (props: { registerSave: SaveRegistrar }): ReturnType<typeof h> => {
    const { registerSave } = props;
    const [shortcut, setShortcut] = useState('');
    const [voice, setVoice] = useState('');
    const [micDeviceId, setMicDeviceId] = useState('');
    const [hideButton, setHideButton] = useState(false);
    const [previewState, setPreviewState] = useState<'idle' | 'loading' | 'played' | 'error'>('idle');
    const [previewMsg, setPreviewMsg] = useState('');
    const [mics, setMics] = useState<Array<{ id: string; label: string }>>([]);
    const [micError, setMicError] = useState('');
    const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
    const [errText, setErrText] = useState('');
    /**
     * 宿主侧全局热键的状态（GET /voice/hotkey）。
     * null = 还没读到；ok=false 时把 message 显示出来——「按了没反应」时这是唯一线索。
     */
    const [hotkey, setHotkey] = useState<{ ok?: boolean; shortcut?: string; watcher?: string; message?: string } | null>(
      null,
    );
    // 顶部有统一的「保存全部」，但卡片内也留一行状态：失败原因在出错的位置更直观
    const statusLine = status === 'saving' ? t('saving') : status === 'saved' ? t('sightSaved') : status === 'error' ? errText : '';

    useEffect(() => {
      let alive = true;
      void (async () => {
        try {
          const res = await fetch('/dsh-whale-girl/voice/config', { cache: 'no-store' });
          if (!res.ok || !alive) return;
          const data = (await res.json()) as { shortcut?: unknown; voice?: unknown; micDeviceId?: unknown; hideButton?: unknown };
          if (!alive) return;
          if (typeof data.shortcut === 'string') setShortcut(data.shortcut);
          if (typeof data.voice === 'string') setVoice(data.voice);
          if (typeof data.micDeviceId === 'string') setMicDeviceId(data.micDeviceId);
          if (data.hideButton === 'true') setHideButton(true);
        } catch {
          /* 取不到就留空，用户自己填 */
        }
      })();
      // 全局热键状态：与配置分开取，取不到不阻塞表单
      void (async () => {
        try {
          const res = await fetch('/dsh-whale-girl/voice/hotkey', { cache: 'no-store' });
          if (!res.ok || !alive) return;
          setHotkey((await res.json()) as { ok?: boolean; shortcut?: string; watcher?: string; message?: string });
        } catch {
          /* 旧宿主没有这个端点：不显示状态即可 */
        }
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
    const refreshMics = async (): Promise<void> => {
      setMicError('');
      try {
        const devices = navigator.mediaDevices;
        if (devices === undefined) throw new Error('这个环境不支持麦克风');
        try {
          const granted = await devices.getUserMedia({ audio: true, video: false });
          granted.getTracks().forEach((track) => track.stop());
        } catch {
          /* 用户拒绝授权也可以枚举，只是名字是空的；不在这里报错 */
        }
        const all = await devices.enumerateDevices();
        const inputs = all
          .filter((d) => d.kind === 'audioinput')
          .map((d, i) => ({ id: d.deviceId, label: d.label || `麦克风 ${i + 1}` }));
        setMics(inputs);
        if (inputs.length === 0) setMicError('没有检测到麦克风');
      } catch (e) {
        setMicError(e instanceof Error ? e.message : String(e));
      }
    };

    useEffect(() => {
      void refreshMics();
    }, []);

    // ── 麦克风测试 ──────────────────────────────────────────────────────
    // 目的很朴素：主人按了麦克风说不确定有没有录进去，这里给一个**看得见的电平**。
    // 做法是拿到真实音频流后接 AnalyserNode 读时域波形的 RMS，
    // 3 秒内峰值超过阈值就判定「有声音」，否则提示「太安静/设备不对」。
    // 测完立刻停轨道关 AudioContext——不能让测试本身占着麦克风。
    const [testing, setTesting] = useState(false);
    const [level, setLevel] = useState(0);
    const [peak, setPeak] = useState(0);
    const [testState, setTestState] = useState<'idle' | 'running' | 'loud' | 'quiet' | 'error'>('idle');
    const [testMsg, setTestMsg] = useState('');
    const testStopRef = useRef<(() => void) | undefined>(undefined);

    useEffect(() => {
      // 组件卸载时收掉测试资源（否则麦克风指示灯一直亮着）
      return () => {
        testStopRef.current?.();
      };
    }, []);

    const startMicTest = async (): Promise<void> => {
      if (testing) {
        testStopRef.current?.();
        return;
      }
      setTestState('running');
      setTestMsg('');
      setLevel(0);
      setPeak(0);
      setTesting(true);

      let stream: MediaStream | undefined;
      let context: AudioContext | undefined;
      let raf = 0;
      let stopped = false;

      const stop = (): void => {
        if (stopped) return;
        stopped = true;
        cancelAnimationFrame(raf);
        stream?.getTracks().forEach((track) => track.stop());
        void context?.close().catch(() => {});
        testStopRef.current = undefined;
        setTesting(false);
        setLevel(0);
      };
      testStopRef.current = stop;

      try {
        const devices = navigator.mediaDevices;
        if (devices === undefined) throw new Error('这个环境不支持麦克风');
        stream = await devices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            ...(micDeviceId === '' ? {} : { deviceId: { exact: micDeviceId } }),
          },
          video: false,
        });
        context = new AudioContext();
        const source = context.createMediaStreamSource(stream);
        const analyser = context.createAnalyser();
        analyser.fftSize = 2048;
        source.connect(analyser);
        const buffer = new Float32Array(analyser.fftSize);

        const startedAt = performance.now();
        let maxPeak = 0;
        const tick = (): void => {
          if (stopped) return;
          analyser.getFloatTimeDomainData(buffer);
          let sum = 0;
          for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
          const rms = Math.sqrt(sum / buffer.length);
          // 0..1 映射：人声正常说话的 RMS 大约 0.02–0.2，平方根拉伸让低音量也看得见
          const shown = Math.min(1, Math.sqrt(rms) * 2.2);
          maxPeak = Math.max(maxPeak, shown);
          setLevel(shown);
          setPeak(maxPeak);
          if (performance.now() - startedAt < 3000) {
            raf = requestAnimationFrame(tick);
            return;
          }
          stop();
          // 阈值 0.06：安静的房间里底噪一般在这之下
          if (maxPeak >= 0.06) {
            setTestState('loud');
            setTestMsg(t('voiceMicTestOk'));
          } else {
            setTestState('quiet');
            setTestMsg(t('voiceMicTestQuiet'));
          }
        };
        raf = requestAnimationFrame(tick);
      } catch (e) {
        stop();
        setTestState('error');
        const name = e instanceof DOMException ? e.name : '';
        setTestMsg(
          name === 'NotAllowedError'
            ? t('voiceMicTestDenied')
            : name === 'OverconstrainedError'
              ? t('voiceMicTestNotFound')
              : e instanceof Error
                ? e.message
                : String(e),
        );
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
    const previewVoice = async (): Promise<void> => {
      setPreviewState('loading');
      setPreviewMsg('');
      try {
        const sample = '主人，我是鲸鱼娘，能听到我吗？';
        const res = await fetch('/dsh-whale-girl/voice/tts', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: sample, voice: voice === '' ? undefined : voice }),
        });
        if (!res.ok) {
          setPreviewState('error');
          setPreviewMsg(`合成失败（HTTP ${res.status}）`);
          return;
        }
        const bytes = await res.arrayBuffer();
        if (bytes.byteLength === 0) {
          setPreviewState('error');
          setPreviewMsg('合成返回空音频');
          return;
        }
        const url = URL.createObjectURL(new Blob([bytes], { type: res.headers.get('content-type') ?? 'audio/mpeg' }));
        const player = new Audio(url);
        player.addEventListener('ended', () => URL.revokeObjectURL(url));
        await player.play();
        // 用 duration 当证据：能播多久说明音频是真的
        const seconds = Number.isFinite(player.duration) ? player.duration.toFixed(1) : '?';
        setPreviewState('played');
        setPreviewMsg(`${t('voicePreviewPlayed')}（${seconds}s，${bytes.byteLength} 字节）`);
      } catch (e) {
        setPreviewState('error');
        setPreviewMsg(e instanceof Error ? e.message : String(e));
      }
    };

    /**
     * 保存语音设置。
     *
     * 返回值是**错误信息**（null = 成功）：置顶的「保存全部」要靠它汇总失败原因。
     * 卡片自己不渲染保存按钮了——全页只有一个保存入口，避免四处分叉。
     */
    const save = async (): Promise<string | null> => {
      setStatus('saving');
      setErrText('');
      try {
        const res = await fetch('/dsh-whale-girl/voice/config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ shortcut, voice, micDeviceId, hideButton: hideButton ? 'true' : 'false' }),
        });
        const data = (await res.json()) as {
          ok?: boolean;
          message?: string;
          hotkey?: { ok?: boolean; shortcut?: string; watcher?: string; message?: string };
        };
        if (data.hotkey !== undefined) setHotkey(data.hotkey);
        if (!res.ok || data.ok !== true) {
          const message = data.message ?? `HTTP ${res.status}`;
          setStatus('error');
          setErrText(message);
          return message;
        }
        // 通知同页的麦克风按钮组件立刻重读配置（隐藏/快捷键即时生效，不用刷新）
        window.dispatchEvent(new Event(VOICE_CONFIG_EVENT));
        setStatus('saved');
        return null;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setStatus('error');
        setErrText(message);
        return message;
      }
    };

    // 把保存函数交给顶部统一按钮（卸载时摘掉，避免留下失效引用）
    useEffect(() => {
      registerSave('voice', save);
      return () => registerSave('voice', null);
    });

    return h('div', {
      className: 'dsh-whale-girl-cfg__card',
      children: [
        cardHead(t('voiceTitle'), t('voiceHint')),
        statusLine === '' ? null : h('p', { className: 'dsh-whale-girl-cfg__note', children: statusLine }),
        // 麦克风选择：整行独占——设备名可能很长，挤在两列里会被截断
        field(
          t('voiceMicLabel'),
          h('div', {
            style: { display: 'flex', gap: '8px', alignItems: 'center' },
            children: [
              h('select', {
                className: inputClass,
                value: micDeviceId,
                style: { flex: '1 1 auto', minWidth: '0' },
                onChange: (e: ChangeEvent<HTMLSelectElement>) => {
                  setMicDeviceId(e.target.value);
                  setStatus('idle');
                },
                children: [
                  h('option', { key: '', value: '', children: t('voiceMicDefault') }),
                  ...mics.map((m) => h('option', { key: m.id, value: m.id, children: m.label })),
                ],
              }),
              h('button', {
                type: 'button',
                className: 'dsh-whale-girl-cfg__btn',
                onClick: () => void refreshMics(),
                children: t('voiceMicRefresh'),
              }),
            ],
          }),
          micError !== ''
            ? `${t('voiceMicHint')}（${micError}）`
            : mics.length > 1
              ? `${t('voiceMicHint')}（检测到 ${mics.length} 个）`
              : t('voiceMicHint'),
          true,
        ),
        // 麦克风测试：一个按钮 + 一根实时电平条 + 结论
        h('div', {
          className: 'dsh-whale-girl-cfg__row',
          style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' },
          children: [
            h('button', {
              type: 'button',
              className: 'dsh-whale-girl-cfg__btn',
              onClick: () => void startMicTest(),
              children: testing ? t('voiceMicTestStop') : t('voiceMicTest'),
            }),
            // 电平条：底槽 + 填充（峰值留一条标记线）
            h('div', {
              style: {
                position: 'relative',
                flex: '1 1 160px',
                minWidth: '120px',
                height: '10px',
                borderRadius: '5px',
                background: 'rgba(255,255,255,.12)',
                overflow: 'hidden',
              },
              children: [
                h('div', {
                  key: 'fill',
                  style: {
                    position: 'absolute',
                    left: '0',
                    top: '0',
                    bottom: '0',
                    width: `${Math.round(level * 100)}%`,
                    background: peak >= 0.06 ? 'rgba(96,220,140,.95)' : 'rgba(96,140,255,.9)',
                    transition: 'width .06s linear',
                  },
                }),
                h('div', {
                  key: 'peak',
                  style: {
                    position: 'absolute',
                    top: '0',
                    bottom: '0',
                    left: `${Math.round(Math.min(99, peak * 100))}%`,
                    width: '2px',
                    background: 'rgba(255,255,255,.85)',
                  },
                }),
              ],
            }),
            testMsg !== ''
              ? h('span', {
                  style: {
                    fontSize: '12px',
                    color:
                      testState === 'loud'
                        ? 'var(--dsw-alias-state-success-primary, #2e9e4f)'
                        : testState === 'error'
                          ? 'var(--dsw-alias-state-error-primary)'
                          : 'var(--dsw-alias-label-secondary)',
                  },
                  children: testMsg,
                })
              : null,
          ],
        }),
        h('p', {
          className: 'dsh-whale-girl-cfg__note',
          children: t('voiceMicTestHint'),
        }),
        // 试听 + 显示开关
        h('div', {
          className: 'dsh-whale-girl-cfg__row',
          style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' },
          children: [
            h('button', {
              type: 'button',
              className: 'dsh-whale-girl-cfg__btn',
              disabled: previewState === 'loading',
              onClick: () => void previewVoice(),
              children: previewState === 'loading' ? t('voicePreviewLoading') : t('voicePreview'),
            }),
            previewMsg !== ''
              ? h('span', {
                  style: {
                    fontSize: '12px',
                    color:
                      previewState === 'error'
                        ? 'var(--dsw-alias-state-error-primary)'
                        : 'var(--dsw-alias-label-secondary)',
                  },
                  children: previewMsg,
                })
              : null,
          ],
        }),
        h('p', {
          className: 'dsh-whale-girl-cfg__note',
          children: t('voicePreviewHint'),
        }),
        // 麦克风按钮显隐：主人嫌那颗按钮又大又挡，可以关掉、只用快捷键
        h('div', {
          className: 'dsh-whale-girl-cfg__row',
          style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' },
          children: [
            h('label', {
              style: { display: 'flex', gap: '8px', alignItems: 'center', cursor: 'pointer' },
              children: [
                h('input', {
                  type: 'checkbox',
                  checked: hideButton,
                  onChange: (e: ChangeEvent<HTMLInputElement>) => {
                    setHideButton(e.target.checked);
                    setStatus('idle');
                  },
                }),
                h('span', { children: t('voiceHideButton') }),
              ],
            }),
          ],
        }),
        h('p', {
          className: 'dsh-whale-girl-cfg__note',
          children: t('voiceHideButtonHint'),
        }),
        h('div', {
          className: 'dsh-whale-girl-cfg__grid2',
          children: [
            field(
              t('voiceShortcutLabel'),
              h('input', {
                type: 'text',
                className: inputClass,
                value: shortcut,
                placeholder: 'Alt+V',
                onChange: (e: ChangeEvent<HTMLInputElement>) => {
                  setShortcut(e.target.value);
                  setStatus('idle');
                },
              }),
              t('voiceShortcutHint'),
            ),
            field(
              t('voiceNameLabel'),
              h('input', {
                type: 'text',
                className: inputClass,
                value: voice,
                placeholder: 'zh-CN-XiaoyiNeural',
                onChange: (e: ChangeEvent<HTMLInputElement>) => {
                  setVoice(e.target.value);
                  setStatus('idle');
                },
              }),
              t('voiceNameHint'),
              true,
            ),
          ],
        }),
        // 全局热键状态：ok=false 时写清楚原因（比如系统级热键不支持那个主键）
        hotkey === null
          ? null
          : h('p', {
              className: 'dsh-whale-girl-cfg__note',
              style: hotkey.ok === true ? undefined : { color: '#ff9a9a' },
              children:
                hotkey.ok === true
                  ? t('voiceHotkeyRunning').replace('{{shortcut}}', hotkey.shortcut ?? '')
                  : t('voiceHotkeyFailed').replace('{{message}}', hotkey.message ?? ''),
            }),
      ],
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
  const MemoryPersonaCard = (): ReturnType<typeof h> => {
    const [prompt, setPrompt] = useState('');
    const [personaSource, setPersonaSource] = useState('');
    const [personaStatus, setPersonaStatus] = useState('');
    const [memCount, setMemCount] = useState<number | null>(null);
    const [importText, setImportText] = useState('');
    const [memStatus, setMemStatus] = useState('');
    const [busy, setBusy] = useState(false);

    const loadPersona = useCallback(async (): Promise<void> => {
      try {
        const res = await fetch('/dsh-whale-girl/persona', { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as { prompt?: string; source?: string };
        setPrompt(typeof data.prompt === 'string' ? data.prompt : '');
        setPersonaSource(typeof data.source === 'string' ? data.source : '');
      } catch {
        /* 读不到就留空 */
      }
    }, []);

    const loadMemory = useCallback(async (): Promise<void> => {
      try {
        const res = await fetch('/dsh-whale-girl/memory', { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as { count?: number };
        setMemCount(typeof data.count === 'number' ? data.count : 0);
      } catch {
        /* 忽略 */
      }
    }, []);

    useEffect(() => {
      void loadPersona();
      void loadMemory();
    }, [loadPersona, loadMemory]);

    const savePersona = async (): Promise<void> => {
      setBusy(true);
      setPersonaStatus('');
      try {
        const res = await fetch('/dsh-whale-girl/persona', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt }),
        });
        const data = (await res.json()) as { ok?: boolean; message?: string; source?: string };
        if (!res.ok || data.ok !== true) {
          setPersonaStatus(data.message ?? 'HTTP ' + res.status);
          return;
        }
        setPersonaSource(data.source ?? '');
        setPersonaStatus(t('personaSaved'));
      } catch (e) {
        setPersonaStatus(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    };

    const importMemory = async (): Promise<void> => {
      if (importText.trim() === '') {
        setMemStatus(t('memoryEmpty'));
        return;
      }
      setBusy(true);
      setMemStatus('');
      try {
        const res = await fetch('/dsh-whale-girl/memory/import', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ payload: importText }),
        });
        const data = (await res.json()) as { ok?: boolean; message?: string; added?: number; total?: number };
        if (!res.ok || data.ok !== true) {
          setMemStatus(data.message ?? 'HTTP ' + res.status);
          return;
        }
        setMemStatus(
          t('memoryImported')
            .replace('{{added}}', String(data.added ?? 0))
            .replace('{{total}}', String(data.total ?? 0)),
        );
        setImportText('');
        await loadMemory();
      } catch (e) {
        setMemStatus(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    };

    const exportMemory = async (): Promise<void> => {
      try {
        const res = await fetch('/dsh-whale-girl/memory/export', { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'whale-girl-memory.json';
        a.click();
        URL.revokeObjectURL(url);
      } catch {
        setMemStatus(t('memoryExportFailed'));
      }
    };

    const clearMemory = async (): Promise<void> => {
      if (!window.confirm(t('memoryClearConfirm'))) return;
      setBusy(true);
      try {
        const res = await fetch('/dsh-whale-girl/memory/clear', { method: 'POST' });
        if (res.ok) {
          setMemStatus(t('memoryCleared'));
          await loadMemory();
        }
      } catch (e) {
        setMemStatus(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    };

    return h('div', {
      className: 'dsh-whale-girl-cfg__card',
      children: [
        cardHead(t('personaTitle'), t('personaHint')),
        h('textarea', {
          className: inputClass,
          rows: 7,
          value: prompt,
          placeholder: t('personaPlaceholder'),
          onChange: (e: ChangeEvent<HTMLTextAreaElement>) => {
            setPrompt(e.target.value);
            setPersonaStatus('');
          },
        }),
        h('p', {
          className: 'dsh-whale-girl-cfg__note',
          children: personaSource === 'persona.json' ? t('personaUsingFile') : t('personaUsingConfig'),
        }),
        h('div', {
          className: 'dsh-whale-girl-cfg__actions',
          children: [
            h('button', {
              type: 'button',
              className: 'dsh-whale-girl-cfg__btn',
              disabled: busy,
              onClick: () => void savePersona(),
              children: t('personaSave'),
            }),
            personaStatus === ''
              ? null
              : h('span', { className: 'dsh-whale-girl-cfg__note', children: personaStatus }),
          ],
        }),

        cardHead(t('memoryTitle'), t('memoryHint').replace('{{count}}', String(memCount ?? '…'))),
        h('textarea', {
          className: inputClass,
          rows: 6,
          value: importText,
          placeholder: t('memoryPlaceholder'),
          onChange: (e: ChangeEvent<HTMLTextAreaElement>) => {
            setImportText(e.target.value);
            setMemStatus('');
          },
        }),
        h('div', {
          className: 'dsh-whale-girl-cfg__actions',
          children: [
            h('input', {
              type: 'file',
              accept: '.json,.txt,application/json,text/plain',
              onChange: (e: ChangeEvent<HTMLInputElement>) => {
                const file = e.target.files?.[0];
                if (file === undefined) return;
                void file.text().then((text) => {
                  setImportText(text);
                  setMemStatus('');
                });
              },
            }),
            h('button', {
              type: 'button',
              className: 'dsh-whale-girl-cfg__btn',
              disabled: busy,
              onClick: () => void importMemory(),
              children: t('memoryImport'),
            }),
            h('button', {
              type: 'button',
              className: 'dsh-whale-girl-cfg__btn',
              disabled: busy,
              onClick: () => void exportMemory(),
              children: t('memoryExport'),
            }),
            h('button', {
              type: 'button',
              className: 'dsh-whale-girl-cfg__btn',
              disabled: busy,
              onClick: () => void clearMemory(),
              children: t('memoryClear'),
            }),
            memStatus === '' ? null : h('span', { className: 'dsh-whale-girl-cfg__note', children: memStatus }),
          ],
        }),
      ],
    });
  };

  /**
   * 对话记录卡：给主人**翻阅**用的完整来往（含动作/神态），与记忆分开。
   *
   * 为什么单独一份：记忆是喂给模型的上下文（只存台词），动作版本存进去会被模仿；
   * 而「对话记录」只显示、不回流，所以可以保留完整的表演细节。
   */
  const ChatLogCard = (): ReturnType<typeof h> => {
    type Entry = { ts: number; user: string; speech: string; action: string };
    const [entries, setEntries] = useState<Entry[]>([]);
    const [hasMore, setHasMore] = useState(false);
    const [loading, setLoading] = useState(false);
    const [status, setStatus] = useState('');

    const load = useCallback(async (before?: number): Promise<void> => {
      setLoading(true);
      setStatus('');
      try {
        const q = new URLSearchParams({ limit: '50' });
        if (before !== undefined) q.set('before', String(before));
        const res = await fetch('/dsh-whale-girl/chatlog?' + q.toString(), { cache: 'no-store' });
        const data = (await res.json()) as { ok?: boolean; entries?: Entry[]; hasMore?: boolean };
        if (!res.ok || data.ok !== true) {
          setStatus('HTTP ' + res.status);
          return;
        }
        setEntries((prev) => (before === undefined ? (data.entries ?? []) : [...prev, ...(data.entries ?? [])]));
        setHasMore(data.hasMore === true);
      } catch (e) {
        setStatus(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    }, []);

    useEffect(() => {
      void load();
    }, [load]);

    const clear = async (): Promise<void> => {
      if (!window.confirm(t('chatlogClearConfirm'))) return;
      try {
        const res = await fetch('/dsh-whale-girl/chatlog/clear', { method: 'POST' });
        if (res.ok) {
          setEntries([]);
          setHasMore(false);
          setStatus(t('chatlogCleared'));
        }
      } catch (e) {
        setStatus(e instanceof Error ? e.message : String(e));
      }
    };

    const exportLog = async (): Promise<void> => {
      try {
        const res = await fetch('/dsh-whale-girl/chatlog/export', { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'whale-girl-chatlog.json';
        a.click();
        URL.revokeObjectURL(url);
      } catch {
        setStatus(t('chatlogLoadFailed'));
      }
    };

    const fmt = (ts: number): string => {
      const d = new Date(ts);
      const p = (n: number): string => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    };

    return h('div', {
      className: 'dsh-whale-girl-cfg__card',
      children: [
        cardHead(t('chatlogTitle'), t('chatlogHint')),
        h('div', {
          className: 'dsh-whale-girl-cfg__actions',
          children: [
            h('button', {
              type: 'button',
              className: 'dsh-whale-girl-cfg__btn',
              disabled: loading,
              onClick: () => void load(),
              children: t('chatlogRefresh'),
            }),
            h('button', {
              type: 'button',
              className: 'dsh-whale-girl-cfg__btn',
              disabled: loading,
              onClick: () => void exportLog(),
              children: t('chatlogExport'),
            }),
            h('button', {
              type: 'button',
              className: 'dsh-whale-girl-cfg__btn',
              disabled: loading,
              onClick: () => void clear(),
              children: t('chatlogClear'),
            }),
            status === '' ? null : h('span', { className: 'dsh-whale-girl-cfg__note', children: status }),
          ],
        }),
        entries.length === 0
          ? h('p', { className: 'dsh-whale-girl-cfg__note', children: loading ? t('chatlogLoading') : t('chatlogEmpty') })
          : h('div', {
              style: { marginTop: '10px' },
              children: entries.map((entry) =>
                h('div', {
                  key: String(entry.ts) + entry.user.slice(0, 8),
                  style: {
                    padding: '10px 0',
                    borderBottom: '1px solid var(--dsw-alias-border-l2)',
                    fontSize: '13px',
                    lineHeight: '20px',
                  },
                  children: [
                    h('div', {
                      className: 'dsh-whale-girl-cfg__note',
                      children: fmt(entry.ts),
                    }),
                    h('div', { children: '主人：' + entry.user }),
                    h('div', { style: { marginTop: '4px' }, children: '鲸鱼娘：' + entry.speech }),
                    entry.action === ''
                      ? null
                      : h('div', {
                          className: 'dsh-whale-girl-cfg__note',
                          style: { marginTop: '4px' },
                          children: '【动作】' + entry.action,
                        }),
                  ],
                }),
              ),
            }),
        hasMore
          ? h('div', {
              className: 'dsh-whale-girl-cfg__actions',
              children: h('button', {
                type: 'button',
                className: 'dsh-whale-girl-cfg__btn',
                disabled: loading,
                onClick: () => {
                  const last = entries[entries.length - 1];
                  if (last !== undefined) void load(last.ts);
                },
                children: t('chatlogLoadMore'),
              }),
            })
          : null,
      ],
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
  const SightSettingsCard = (props: { registerSave: SaveRegistrar }): ReturnType<typeof h> => {
    const { registerSave } = props;
    const [enabled, setEnabled] = useState(false);
    const [intervalSec, setIntervalSec] = useState(60);
    const [keepSnapshots, setKeepSnapshots] = useState(20);
    const [speak, setSpeak] = useState(false);
    const [mode, setMode] = useState<'companion' | 'play' | 'watch'>('companion');
    const [jitterMin, setJitterMin] = useState(0.6);
    const [jitterMax, setJitterMax] = useState(1.6);
    const [memoryShared, setMemoryShared] = useState(true);
    /** 语音对话里主动识屏：off / auto / always */
    const [voiceVision, setVoiceVision] = useState<'off' | 'auto' | 'always'>('auto');
    /** 连拍帧数：1 = 最省，3~5 能看出画面变化 */
    const [voiceFrames, setVoiceFrames] = useState(3);
    /** 连拍帧间隔（毫秒） */
    const [voiceFrameGapMs, setVoiceFrameGapMs] = useState(700);
    const [snapshots, setSnapshots] = useState<{ count: number; bytes: number }>({ count: 0, bytes: 0 });
    const [dir, setDir] = useState('');
    /** 实际生效的识图模型（服务商/模型）。null = 还没解析出来 */
    const [visionResolved, setVisionResolved] = useState<{ provider: string; model: string } | null>(null);
    const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
    const [errText, setErrText] = useState('');
    // 顶部有统一的「保存全部」，但卡片内也留一行状态：失败原因在出错的位置更直观
    const statusLine = status === 'saving' ? t('saving') : status === 'saved' ? t('sightSaved') : status === 'error' ? errText : '';
    const [runState, setRunState] = useState<'idle' | 'running' | 'done'>('idle');
    const [runMsg, setRunMsg] = useState('');
    /** 最近一次快照的文件名清单（点开可看原图） */
    const [files, setFiles] = useState<string[]>([]);

    const reload = useCallback(async (): Promise<void> => {
      try {
        const res = await fetch('/dsh-whale-girl/sight/config');
        if (!res.ok) return;
        const data = (await res.json()) as {
          config?: {
            enabled?: boolean;
            intervalSec?: number;
            keepSnapshots?: number;
            speak?: boolean;
            mode?: string;
            jitterMin?: number;
            jitterMax?: number;
            memoryShared?: boolean;
            voiceVision?: string;
            voiceFrames?: number;
            voiceFrameGapMs?: number;
          };
          snapshots?: { count?: number; bytes?: number };
          dir?: string;
          /** 宿主算好的「实际会用哪个模型识别」 */
          visionModelResolved?: { provider?: string; model?: string } | null;
        };
        if (data.config) {
          setEnabled(data.config.enabled === true);
          setIntervalSec(data.config.intervalSec ?? 60);
          setKeepSnapshots(data.config.keepSnapshots ?? 20);
          setSpeak(data.config.speak === true);
          if (data.config.mode === 'play' || data.config.mode === 'watch' || data.config.mode === 'companion') setMode(data.config.mode);
          if (typeof data.config.jitterMin === 'number') setJitterMin(data.config.jitterMin);
          if (typeof data.config.jitterMax === 'number') setJitterMax(data.config.jitterMax);
          setMemoryShared(data.config.memoryShared !== false);
          if (data.config.voiceVision === 'off' || data.config.voiceVision === 'always' || data.config.voiceVision === 'auto') setVoiceVision(data.config.voiceVision);
          if (typeof data.config.voiceFrames === 'number') setVoiceFrames(data.config.voiceFrames);
          if (typeof data.config.voiceFrameGapMs === 'number') setVoiceFrameGapMs(data.config.voiceFrameGapMs);
        }
        setSnapshots({ count: data.snapshots?.count ?? 0, bytes: data.snapshots?.bytes ?? 0 });
        setDir(data.dir ?? '');
        // 实际生效的识图模型（宿主侧算好的，前端只负责显示）
        setVisionResolved(
          data.visionModelResolved &&
            typeof data.visionModelResolved.provider === 'string' &&
            typeof data.visionModelResolved.model === 'string'
            ? { provider: data.visionModelResolved.provider, model: data.visionModelResolved.model }
            : null,
        );
        // 快照文件名：从 /sight/config 的目录里列不出来，改用 state 里没有——
        // 这里直接调一个轻量路由拿清单（见 host 的 sight/snapshots）
        const listRes = await fetch('/dsh-whale-girl/sight/snapshots');
        if (listRes.ok) {
          const listData = (await listRes.json()) as { files?: string[] };
          setFiles(Array.isArray(listData.files) ? listData.files : []);
        }
      } catch {
        /* 读不到就保持默认显示，不报错打扰 */
      }
    }, []);

    useEffect(() => {
      void reload();
    }, [reload]);

    /** 保存识屏设置（返回错误信息，null = 成功；由顶部统一按钮调用） */
    const save = async (): Promise<string | null> => {
      setStatus('saving');
      setErrText('');
      try {
        const res = await fetch('/dsh-whale-girl/sight/config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
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
            voiceFrameGapMs,
          }),
        });
        const data = (await res.json()) as { ok?: boolean; message?: string };
        if (!res.ok || data.ok !== true) {
          const message = data.message ?? `HTTP ${res.status}`;
          setStatus('error');
          setErrText(message);
          return message;
        }
        setStatus('saved');
        await reload();
        return null;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setStatus('error');
        setErrText(message);
        return message;
      }
    };

    useEffect(() => {
      registerSave('sight', save);
      return () => registerSave('sight', null);
    });

    const runOnce = async (): Promise<void> => {
      setRunState('running');
      setRunMsg('');
      try {
        const res = await fetch('/dsh-whale-girl/sight/run', { method: 'POST' });
        const data = (await res.json()) as { kind?: string; reason?: string; text?: string; message?: string };
        if (data.kind === 'spoke') {
          setRunMsg(`${t('sightRunSpoke')}：${data.text ?? ''}`);
        } else if (data.kind === 'skipped') {
          setRunMsg(t('sightRunSkipped') + `（${data.reason ?? ''}）`);
        } else {
          setRunMsg(`${t('sightRunFailed')}：${data.message ?? data.reason ?? ''}`);
        }
        setRunState('done');
        await reload();
      } catch (e) {
        setRunState('done');
        setRunMsg(e instanceof Error ? e.message : String(e));
      }
    };

    return h('div', {
      className: 'dsh-whale-girl-cfg__card',
      children: [
        h('h3', { className: 'dsh-whale-girl-cfg__title', children: t('sightTitle') }),
        statusLine === '' ? null : h('p', { className: 'dsh-whale-girl-cfg__note', children: statusLine }),
        h('p', { className: 'dsh-whale-girl-cfg__note', children: t('sightHint') }),

        // 总开关
        h('div', {
          style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' },
          children: [
            h('label', {
              style: { display: 'flex', gap: '8px', alignItems: 'center', cursor: 'pointer' },
              children: [
                h('input', {
                  type: 'checkbox',
                  checked: enabled,
                  onChange: (e: ChangeEvent<HTMLInputElement>) => {
                    setEnabled(e.target.checked);
                    setStatus('idle');
                  },
                }),
                h('span', { children: t('sightEnabled') }),
              ],
            }),
          ],
        }),
        h('p', { className: 'dsh-whale-girl-cfg__note', children: t('sightEnabledHint') }),

        // 实际生效的模型：让主人一眼看到「到底是谁在识别、烧的是谁的钱」
        h('p', {
          className: 'dsh-whale-girl-cfg__note',
          style: { fontFamily: MONO },
          children:
            t('sightVisionModelLabel') +
            '：' +
            (visionResolved === null
              ? '—'
              : `${visionResolved.provider}/${visionResolved.model}`),
        }),

        // 频率 + 保留张数
        h('div', {
          className: 'dsh-whale-girl-cfg__grid2',
          children: [
            field(
              t('sightIntervalLabel'),
              h('input', {
                type: 'number',
                className: inputClass,
                min: 15,
                max: 3600,
                value: intervalSec,
                onChange: (e: ChangeEvent<HTMLInputElement>) => {
                  setIntervalSec(Number(e.target.value) || 60);
                  setStatus('idle');
                },
              }),
              t('sightIntervalHint'),
            ),
            field(
              t('sightKeepLabel'),
              h('input', {
                type: 'number',
                className: inputClass,
                min: 0,
                max: 200,
                value: keepSnapshots,
                onChange: (e: ChangeEvent<HTMLInputElement>) => {
                  setKeepSnapshots(Number(e.target.value) || 0);
                  setStatus('idle');
                },
              }),
              t('sightKeepHint'),
            ),
          ],
        }),

        // 模式：日常陪聊 / 陪玩 / 只看不说
        h('div', {
          className: 'dsh-whale-girl-cfg__row',
          style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' },
          children: [
            h('span', { children: t('sightModeLabel') }),
            h('select', {
              className: inputClass,
              value: mode,
              onChange: (e: ChangeEvent<HTMLSelectElement>) => {
                const v = e.target.value;
                if (v === 'companion' || v === 'play' || v === 'watch') setMode(v);
                setStatus('idle');
              },
              children: [
                h('option', { key: 'companion', value: 'companion', children: t('sightModeCompanion') }),
                h('option', { key: 'play', value: 'play', children: t('sightModePlay') }),
                h('option', { key: 'watch', value: 'watch', children: t('sightModeWatch') }),
              ],
            }),
          ],
        }),
        h('p', { className: 'dsh-whale-girl-cfg__note', children: t('sightModeHint') }),

        // 随机区间：固定频率太机械，改成「60 秒 × 0.6~1.6」这种不规则感
        h('div', {
          className: 'dsh-whale-girl-cfg__grid2',
          children: [
            field(
              t('sightJitterMinLabel'),
              h('input', {
                type: 'number',
                className: inputClass,
                min: 0.2,
                max: 3,
                step: 0.1,
                value: jitterMin,
                onChange: (e: ChangeEvent<HTMLInputElement>) => {
                  setJitterMin(Number(e.target.value) || 0.6);
                  setStatus('idle');
                },
              }),
              t('sightJitterHint'),
            ),
            field(
              t('sightJitterMaxLabel'),
              h('input', {
                type: 'number',
                className: inputClass,
                min: 0.2,
                max: 5,
                step: 0.1,
                value: jitterMax,
                onChange: (e: ChangeEvent<HTMLInputElement>) => {
                  setJitterMax(Number(e.target.value) || 1.6);
                  setStatus('idle');
                },
              }),
              t('sightJitterHint'),
            ),
          ],
        }),

        // 记忆共用
        h('div', {
          style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' },
          children: [
            h('label', {
              style: { display: 'flex', gap: '8px', alignItems: 'center', cursor: 'pointer' },
              children: [
                h('input', {
                  type: 'checkbox',
                  checked: memoryShared,
                  onChange: (e: ChangeEvent<HTMLInputElement>) => {
                    setMemoryShared(e.target.checked);
                    setStatus('idle');
                  },
                }),
                h('span', { children: t('sightMemoryShared') }),
              ],
            }),
          ],
        }),
        h('p', { className: 'dsh-whale-girl-cfg__note', children: t('sightMemoryHint') }),

        // 要不要出声
        h('div', {
          style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' },
          children: [
            h('label', {
              style: { display: 'flex', gap: '8px', alignItems: 'center', cursor: 'pointer' },
              children: [
                h('input', {
                  type: 'checkbox',
                  checked: speak,
                  onChange: (e: ChangeEvent<HTMLInputElement>) => {
                    setSpeak(e.target.checked);
                    setStatus('idle');
                  },
                }),
                h('span', { children: t('sightSpeak') }),
              ],
            }),
          ],
        }),
        h('p', { className: 'dsh-whale-girl-cfg__note', children: t('sightSpeakHint') }),


        // ── 语音对话里的主动识屏 ──
        //
        // 她说「我在干嘛」这种话时，应该自己看一眼再答。但每句都看太贵，
        // 所以档位可调；帧数决定能不能看出"画面在变化"。
        h('div', {
          className: 'dsh-whale-girl-cfg__grid2',
          children: [
            field(
              t('voiceVisionLabel'),
              h('select', {
                className: inputClass,
                value: voiceVision,
                onChange: (e: ChangeEvent<HTMLSelectElement>) => {
                  const v = e.target.value;
                  if (v === 'off' || v === 'auto' || v === 'always') setVoiceVision(v);
                  setStatus('idle');
                },
                children: [
                  h('option', { key: 'off', value: 'off', children: t('voiceVisionOff') }),
                  h('option', { key: 'auto', value: 'auto', children: t('voiceVisionAuto') }),
                  h('option', { key: 'always', value: 'always', children: t('voiceVisionAlways') }),
                ],
              }),
              t('voiceVisionHint'),
            ),
            field(
              t('voiceFramesLabel'),
              h('input', {
                type: 'number',
                className: inputClass,
                min: 1,
                max: 5,
                value: voiceFrames,
                onChange: (e: ChangeEvent<HTMLInputElement>) => {
                  setVoiceFrames(Number(e.target.value) || 1);
                  setStatus('idle');
                },
              }),
              t('voiceFramesHint'),
            ),
          ],
        }),
        field(
          t('voiceGapLabel'),
          h('input', {
            type: 'number',
            className: inputClass,
            min: 200,
            max: 2000,
            step: 100,
            value: voiceFrameGapMs,
            onChange: (e: ChangeEvent<HTMLInputElement>) => {
              setVoiceFrameGapMs(Number(e.target.value) || 700);
              setStatus('idle');
            },
          }),
          t('voiceGapHint'),
        ),
        // 立刻看一次
        h('div', {
          style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' },
          children: [
            h('button', {
              type: 'button',
              className: 'dsh-whale-girl-cfg__btn',
              disabled: runState === 'running',
              onClick: () => void runOnce(),
              children: runState === 'running' ? t('sightRunning') : t('sightRunNow'),
            }),
            runMsg === ''
              ? null
              : h('span', { className: 'dsh-whale-girl-cfg__note', children: runMsg }),
          ],
        }),


        // 快照核对区
        h('p', {
          className: 'dsh-whale-girl-cfg__note',
          children: `${t('sightSnapshots')}：${snapshots.count} 张 / ${Math.round(snapshots.bytes / 1024)} KB${
            dir === '' ? '' : `　（${dir}）`
          }`,
        }),
        files.length === 0
          ? null
          : h('div', {
              style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '6px' },
              children: files.slice(-6).map((name) =>
                h('a', {
                  key: name,
                  href: `/dsh-whale-girl/sight/snapshot/${encodeURIComponent(name)}`,
                  target: '_blank',
                  rel: 'noreferrer',
                  title: name,
                  children: h('img', {
                    src: `/dsh-whale-girl/sight/snapshot/${encodeURIComponent(name)}`,
                    alt: name,
                    style: {
                      width: '120px',
                      height: '75px',
                      objectFit: 'cover',
                      borderRadius: '6px',
                      border: '1px solid rgba(255,255,255,.18)',
                      display: 'block',
                    },
                  }),
                }),
              ),
            }),
      ],
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
  const AppsCard = (): ReturnType<typeof h> => {
    const [text, setText] = useState('');
    const [msg, setMsg] = useState('');
    const [busy, setBusy] = useState(false);

    const load = useCallback(async (): Promise<void> => {
      try {
        const res = await fetch('/dsh-whale-girl/apps/aliases');
        if (!res.ok) return;
        const data = (await res.json()) as { aliases?: Record<string, string> };
        setText(Object.entries(data.aliases ?? {}).map(([k, v]) => `${k}=${v}`).join('\n'));
      } catch {
        /* 读不到就空着，用户仍可手写 */
      }
    }, []);

    useEffect(() => {
      void load();
    }, [load]);

    const save = async (): Promise<void> => {
      const map: Record<string, string> = {};
      for (const line of text.split('\n')) {
        const i = line.indexOf('=');
        if (i <= 0) continue;
        const k = line.slice(0, i).trim();
        const v = line.slice(i + 1).trim();
        if (k !== '' && v !== '') map[k] = v;
      }
      setBusy(true);
      setMsg('');
      try {
        const res = await fetch('/dsh-whale-girl/apps/aliases', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(map),
        });
        const d = (await res.json()) as { ok?: boolean; message?: string };
        setMsg(d.ok === true ? t('appsSaved') : (d.message ?? t('appsFailed')));
      } catch (e) {
        setMsg(e instanceof Error ? e.message : t('appsFailed'));
      } finally {
        setBusy(false);
      }
    };

    return h('div', { className: 'dsh-whale-girl-cfg__card', children: [
      h('h3', { key: 't', className: 'dsh-whale-girl-cfg__title', children: t('appsTitle') }),
      h('p', { key: 'h', className: 'dsh-whale-girl-cfg__note', children: t('appsHint') }),
      h('textarea', {
        key: 'ta',
        className: inputClass,
        rows: 14,
        value: text,
        spellCheck: false,
        onChange: (e: ChangeEvent<HTMLTextAreaElement>) => {
          setText(e.target.value);
          setMsg('');
        },
      }),
      h('div', {
        key: 'a',
        className: 'dsh-whale-girl-cfg__actions',
        children: [
          h('button', { key: 's', type: 'button', disabled: busy, onClick: () => void save(), children: t('appsSave') }),
          h('button', { key: 'r', type: 'button', disabled: busy, onClick: () => void load(), children: t('appsReload') }),
          msg === '' ? null : h('span', { key: 'm', className: 'dsh-whale-girl-cfg__note', children: msg }),
        ],
      }),
    ] });
  };
  const AutoplaySettingsCard = (props: { registerSave: SaveRegistrar }): ReturnType<typeof h> => {
    const { registerSave } = props;
    // ── 游戏档案（她怎么玩这款）──
    const [gameTitle, setGameTitle] = useState('');
    const [gameGenre, setGameGenre] = useState('custom');
    const [gameKeys, setGameKeys] = useState('');
    const [gameNotes, setGameNotes] = useState('');
    /** 本局记忆容量（空 = 用类型预设） */
    const [gameCap, setGameCap] = useState('');
    /** 各类型的预设容量（宿主给，用于在旁边提示） */
    const [genreCaps, setGenreCaps] = useState<Record<string, number>>({});
    const [gameMsg, setGameMsg] = useState('');
    const [guideBusy, setGuideBusy] = useState(false);
    /** 本局进度文案 */
    const [sessionText, setSessionText] = useState('');

    /** 读回档案与本局进度 */
    const reloadGame = useCallback(async (): Promise<void> => {
      try {
        const res = await fetch('/dsh-whale-girl/autoplay/games');
        if (res.ok) {
          const data = (await res.json()) as {
            games?: Array<{ title?: string; genre?: string; keys?: Record<string, string>; notes?: string[]; memoryCap?: number }>;
            genreCaps?: Record<string, number>;
          };
          if (data.genreCaps !== undefined) setGenreCaps(data.genreCaps);
          const first = data.games?.[0];
          if (first !== undefined) {
            setGameTitle(first.title ?? '');
            setGameGenre(first.genre ?? 'custom');
            setGameKeys(Object.entries(first.keys ?? {}).map(([k, v]) => k + '=' + v).join('\n'));
            setGameNotes((first.notes ?? []).join('\n'));
            setGameCap(typeof first.memoryCap === 'number' ? String(first.memoryCap) : '');
          }
        }
        const sres = await fetch('/dsh-whale-girl/autoplay/session');
        if (sres.ok) {
          const sdata = (await sres.json()) as { session?: { gameTitle?: string; steps?: number; cap?: number } | null };
          const s = sdata.session;
          setSessionText(
            s === null || s === undefined
              ? t('sessionNone')
              : `${s.gameTitle ?? ''}：已记 ${s.steps ?? 0} / ${s.cap ?? 0} 步`,
          );
        }
      } catch {
        /* 读不到就保持空 */
      }
    }, []);

    useEffect(() => {
      void reloadGame();
    }, [reloadGame]);

    /** 保存档案（键位按「动作=键」每行一条） */
    const saveGame = async (): Promise<void> => {
      const keys: Record<string, string> = {};
      for (const line of gameKeys.split('\n')) {
        const idx = line.indexOf('=');
        if (idx <= 0) continue;
        const action = line.slice(0, idx).trim();
        const key = line.slice(idx + 1).trim();
        if (action !== '' && key !== '') keys[action] = key;
      }
      setGameMsg('');
      try {
        const res = await fetch('/dsh-whale-girl/autoplay/games', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            title: gameTitle,
            genre: gameGenre,
            keys,
            notes: gameNotes.split('\n').map((s) => s.trim()).filter((s) => s !== ''),
            ...(gameCap.trim() === '' ? {} : { memoryCap: Number(gameCap) }),
          }),
        });
        const data = (await res.json()) as { ok?: boolean; message?: string };
        setGameMsg(data.ok === true ? t('gameSaved') : (data.message ?? `HTTP ${res.status}`));
      } catch (e) {
        setGameMsg(e instanceof Error ? e.message : String(e));
      }
    };

    /** 联网查攻略（走宿主 ctx.web，结果写进档案） */
    const lookupGuide = async (): Promise<void> => {
      if (gameTitle.trim() === '') {
        setGameMsg(t('gameNeedName'));
        return;
      }
      setGuideBusy(true);
      setGameMsg('');
      try {
        const res = await fetch('/dsh-whale-girl/autoplay/guide', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: gameTitle.trim() }),
        });
        const data = (await res.json()) as { ok?: boolean; message?: string; guide?: { summary?: string } };
        setGameMsg(
          data.ok === true
            ? t('gameGuideDone') + '：' + (data.guide?.summary ?? '').slice(0, 80)
            : (data.message ?? t('gameGuideFailed')),
        );
      } catch (e) {
        setGameMsg(e instanceof Error ? e.message : String(e));
      } finally {
        setGuideBusy(false);
      }
    };

    /** 结束本局：压缩进共用记忆 */
    const endSession = async (): Promise<void> => {
      try {
        const res = await fetch('/dsh-whale-girl/autoplay/end', { method: 'POST' });
        const data = (await res.json()) as { ended?: { steps?: number; summary?: string } | null };
        setGameMsg(
          data.ended === null || data.ended === undefined
            ? t('sessionNothing')
            : t('sessionEnded') + '：' + (data.ended.summary ?? ''),
        );
        // 「结束本局」现在同时停掉陪玩循环：按钮文案也要立刻回到「开始陪玩」
        setPlaying(false);
        await reloadGame();
      } catch (e) {
        setGameMsg(e instanceof Error ? e.message : String(e));
      }
    };
    const [enabled, setEnabled] = useState(false);
    const [dryRun, setDryRun] = useState(true);
    const [estopKey, setEstopKey] = useState('f12');
    const [windowTitles, setWindowTitles] = useState('');
    const [busyNow, setBusyNow] = useState(false);
    const [running, setRunning] = useState(false);
    /** 陪玩循环是否在跑（由 /autoplay/play 决定，不是本地开关） */
    const [playing, setPlaying] = useState(false);
    const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
    const [errText, setErrText] = useState('');
    // 顶部有统一的「保存全部」，但卡片内也留一行状态：失败原因在出错的位置更直观
    const statusLine = status === 'saving' ? t('saving') : status === 'saved' ? t('sightSaved') : status === 'error' ? errText : '';
    const [log, setLog] = useState<string[]>([]);
    const [estopState, setEstopState] = useState<{ state: string; lastReason?: string }>({ state: 'unknown' });
    const [fg, setFg] = useState('');
    /** 正在运行的窗口（点选白名单用；不用主人手打标题） */
    const [windowChoices, setWindowChoices] = useState<Array<{ title: string; processName?: string; pid?: number }>>([]);
    /** 代打专用识图模型：'' = 跟随对话模型 */
    const [visionProvider, setVisionProvider] = useState('');
    const [visionModelId, setVisionModelId] = useState('');
    const [modelProviders, setModelProviders] = useState<
      Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }>
    >([]);

    const reload = useCallback(async (): Promise<void> => {
      try {
        const res = await fetch('/dsh-whale-girl/autoplay/config');
        if (!res.ok) return;
        const data = (await res.json()) as {
          config?: {
            enabled?: boolean;
            dryRun?: boolean;
            estopKey?: string;
            windowTitles?: string[];
            visionModel?: { provider?: string; model?: string };
          };
          estop?: { state?: string; lastReason?: string };
        };
        if (data.config) {
          setEnabled(data.config.enabled === true);
          setDryRun(data.config.dryRun !== false);
          if (typeof data.config.estopKey === 'string') setEstopKey(data.config.estopKey);
          if (Array.isArray(data.config.windowTitles)) setWindowTitles(data.config.windowTitles.join('\n'));
          setVisionProvider(typeof data.config.visionModel?.provider === 'string' ? data.config.visionModel.provider : '');
          setVisionModelId(typeof data.config.visionModel?.model === 'string' ? data.config.visionModel.model : '');
        }
        if (data.estop) setEstopState({ state: data.estop.state ?? 'unknown', lastReason: data.estop.lastReason });
        // 陪玩循环状态：按钮文案与「进行中」提示都跟它走
        try {
          const playRes = await fetch('/dsh-whale-girl/autoplay/play', { cache: 'no-store' });
          if (playRes.ok) {
            const playData = (await playRes.json()) as { play?: { running?: boolean } };
            setPlaying(playData.play?.running === true);
          }
        } catch {
          /* 旧宿主没有这个端点：按钮仍可用（开始会报 404 原因） */
        }
      } catch {
        /* 读不到就保持默认显示 */
      }
    }, []);

    useEffect(() => {
      void reload();
    }, [reload]);

    /**
     * 拉「正在运行的窗口」列表。
     *
     * 白名单靠手打标题太费劲，而且中文游戏名常和窗口英文标题对不上
     * （苏丹的游戏 ↔ Sultan's Game）。这里直接列真实窗口，点一下就写进白名单。
     */
    const refreshWindowChoices = useCallback(async (): Promise<void> => {
      try {
        const res = await fetch('/dsh-whale-girl/autoplay/windows', { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as {
          windows?: Array<{ title?: unknown; processName?: unknown; pid?: unknown }>;
        };
        setWindowChoices(
          (data.windows ?? []).filter(
            (w): w is { title: string; processName?: string; pid?: number } =>
              typeof w.title === 'string' && w.title.trim() !== '',
          ),
        );
      } catch {
        /* 取不到就留空，不阻塞表单 */
      }
    }, []);

    useEffect(() => {
      void refreshWindowChoices();
    }, [refreshWindowChoices]);

    // 模型列表：给「代打用的识图模型」下拉框用（空 = 跟随对话模型）
    useEffect(() => {
      void (async () => {
        try {
          const res = await fetch('/dsh-whale-girl/models', { cache: 'no-store' });
          if (!res.ok) return;
          const data = (await res.json()) as {
            providers?: Array<{ id?: unknown; name?: unknown; models?: Array<{ id?: unknown; name?: unknown }> }>;
          };
          setModelProviders(
            (data.providers ?? [])
              .map((p) => ({
                id: String(p.id ?? ''),
                name: String(p.name ?? '') || String(p.id ?? ''),
                models: (p.models ?? [])
                  .map((m) => ({ id: String(m.id ?? ''), name: String(m.name ?? '') || String(m.id ?? '') }))
                  .filter((m) => m.id !== ''),
              }))
              .filter((p) => p.id !== ''),
          );
        } catch {
          /* 旧宿主没有 /models：下拉框只有「跟随对话模型」 */
        }
      })();
    }, []);

    /** 保存代打设置（返回错误信息，null = 成功；由顶部统一按钮调用） */
    const save = async (): Promise<string | null> => {
      setStatus('saving');
      setErrText('');
      try {
        const res = await fetch('/dsh-whale-girl/autoplay/config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            enabled,
            dryRun,
            estopKey,
            windowTitles: windowTitles
              .split('\n')
              .map((s) => s.trim())
              .filter((s) => s !== ''),
            visionModel:
              visionProvider === '' || visionModelId === ''
                ? null
                : { provider: visionProvider, model: visionModelId },
          }),
        });
        const data = (await res.json()) as { ok?: boolean; message?: string };
        if (!res.ok || data.ok !== true) {
          const message = data.message ?? `HTTP ${res.status}`;
          setStatus('error');
          setErrText(message);
          return message;
        }
        setStatus('saved');
        await reload();
        return null;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setStatus('error');
        setErrText(message);
        return message;
      }
    };

    useEffect(() => {
      registerSave('autoplay', save);
      return () => registerSave('autoplay', null);
    });

    /** 跑一轮（空跑时只是「看一眼 + 打印打算」） */
    const runOnce = async (): Promise<void> => {
      setRunning(true);
      setBusyNow(true);
      try {
        const res = await fetch('/dsh-whale-girl/autoplay/run', { method: 'POST' });
        const data = (await res.json()) as {
          kind?: string;
          reason?: string;
          thought?: string;
          executed?: boolean;
          detail?: string;
          message?: string;
        };
        const line =
          data.kind === 'planned'
            ? `[${data.executed ? '执行' : '空跑'}] ${data.thought ?? ''}`
            : data.kind === 'skipped'
              ? `[跳过] ${data.reason ?? ''}${data.detail ? '：' + data.detail : ''}`
              : data.kind === 'stopped'
                ? `[急停] ${data.reason ?? ''}`
                : `[失败] ${data.message ?? data.reason ?? ''}`;
        setLog((prev) => [new Date().toLocaleTimeString() + ' ' + line, ...prev].slice(0, 30));
        await reload();
      } catch (e) {
        setLog((prev) => [`[错误] ${e instanceof Error ? e.message : String(e)}`, ...prev].slice(0, 30));
      } finally {
        setRunning(false);
        setBusyNow(false);
      }
    };

    /** 开始陪玩：把表单当前值直接交给宿主并落盘（不依赖顶部「保存」） */
    const startPlay = async (): Promise<void> => {
      setBusyNow(true);
      try {
        const titles = windowTitles
          .split('\n')
          .map((s) => s.trim())
          .filter((s) => s !== '');
        const res = await fetch('/dsh-whale-girl/autoplay/play/start', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            dryRun,
            estopKey,
            windowTitles: titles,
            visionModel:
              visionProvider === '' || visionModelId === ''
                ? null
                : { provider: visionProvider, model: visionModelId },
          }),
        });
        const data = (await res.json()) as { ok?: boolean; message?: string; play?: { lastMessage?: string } };
        if (!res.ok || data.ok !== true) {
          setLog((prev) => [`[开始失败] ${data.message ?? 'HTTP ' + res.status}`, ...prev].slice(0, 30));
          return;
        }
        setEnabled(true);
        setLog((prev) => [`[开始陪玩] ${data.play?.lastMessage ?? '已启动'}`, ...prev].slice(0, 30));
        await reload();
      } catch (e) {
        setLog((prev) => [`[开始失败] ${e instanceof Error ? e.message : String(e)}`, ...prev].slice(0, 30));
      } finally {
        setBusyNow(false);
      }
    };

    /** 停止陪玩：停循环 + 急停 + 把本局压缩进记忆 */
    const stopPlay = async (): Promise<void> => {
      setBusyNow(true);
      try {
        const res = await fetch('/dsh-whale-girl/autoplay/play/stop', { method: 'POST' });
        const data = (await res.json()) as { play?: { lastMessage?: string } };
        setLog((prev) => [`[已停止] ${data.play?.lastMessage ?? ''}`, ...prev].slice(0, 30));
        await reload();
      } catch (e) {
        setLog((prev) => [`[停止失败] ${e instanceof Error ? e.message : String(e)}`, ...prev].slice(0, 30));
      } finally {
        setBusyNow(false);
      }
    };

    /** 恢复急停（主人手动确认「我允许她继续」） */
    const resume = async (): Promise<void> => {
      try {
        await fetch('/dsh-whale-girl/autoplay/resume', { method: 'POST' });
        await reload();
      } catch {
        /* 恢复失败就保持停止态，安全 */
      }
    };

    return h('div', {
      className: 'dsh-whale-girl-cfg__card',
      children: [
        h('h3', { className: 'dsh-whale-girl-cfg__title', children: t('playTitle') }),
        statusLine === '' ? null : h('p', { className: 'dsh-whale-girl-cfg__note', children: statusLine }),
        h('p', { className: 'dsh-whale-girl-cfg__note', children: t('playHint') }),

        // 总开关 + 空跑
        h('div', {
          className: 'dsh-whale-girl-cfg__grid2',
          children: [
            field(
              t('playEnabled'),
              h('label', {
                style: { display: 'flex', gap: '8px', alignItems: 'center', cursor: 'pointer' },
                children: [
                  h('input', {
                    type: 'checkbox',
                    checked: enabled,
                    onChange: (e: ChangeEvent<HTMLInputElement>) => {
                      setEnabled(e.target.checked);
                      setStatus('idle');
                    },
                  }),
                  h('span', { children: enabled ? t('playOn') : t('playOff') }),
                ],
              }),
              t('playEnabledHint'),
            ),
            field(
              t('playDryRun'),
              h('label', {
                style: { display: 'flex', gap: '8px', alignItems: 'center', cursor: 'pointer' },
                children: [
                  h('input', {
                    type: 'checkbox',
                    checked: dryRun,
                    onChange: (e: ChangeEvent<HTMLInputElement>) => {
                      setDryRun(e.target.checked);
                      setStatus('idle');
                    },
                  }),
                  h('span', { children: dryRun ? t('playDryOn') : t('playDryOff') }),
                ],
              }),
              t('playDryHint'),
            ),
          ],
        }),

        // 代打专用识图模型：对话模型常常是重推理模型（一轮几十秒、还会空回复），
        // 代打可以单独挑一个「快、能看图、按格式吐一行」的模型。
        field(
          t('playVisionModel'),
          h('div', {
            style: { display: 'flex', gap: '8px', flexWrap: 'wrap' },
            children: [
              h('select', {
                className: inputClass,
                value: visionProvider,
                onChange: (e: ChangeEvent<HTMLSelectElement>) => {
                  setVisionProvider(e.target.value);
                  setVisionModelId('');
                  setStatus('idle');
                },
                children: [
                  h('option', { value: '', children: t('playVisionFollow') }),
                  ...modelProviders.map((p) => h('option', { key: p.id, value: p.id, children: p.name })),
                ],
              }),
              visionProvider === ''
                ? null
                : h('select', {
                    className: inputClass,
                    value: visionModelId,
                    onChange: (e: ChangeEvent<HTMLSelectElement>) => {
                      setVisionModelId(e.target.value);
                      setStatus('idle');
                    },
                    children: [
                      h('option', { value: '', children: t('playVisionPickModel') }),
                      ...(modelProviders.find((p) => p.id === visionProvider)?.models ?? []).map((m) =>
                        h('option', { key: m.id, value: m.id, children: m.name }),
                      ),
                    ],
                  }),
            ],
          }),
          t('playVisionHint'),
        ),

        // 急停键
        h('div', {
          className: 'dsh-whale-girl-cfg__grid2',
          children: [
            field(
              t('playEstopKey'),
              h('select', {
                className: inputClass,
                value: estopKey,
                onChange: (e: ChangeEvent<HTMLSelectElement>) => {
                  setEstopKey(e.target.value);
                  setStatus('idle');
                },
                children: ['f8', 'f9', 'f10', 'f11', 'f12', 'esc', 'pause', 'scrolllock'].map((k) =>
                  h('option', { key: k, value: k, children: k.toUpperCase() }),
                ),
              }),
              t('playEstopHint'),
            ),
            field(
              t('playEstopState'),
              h('div', {
                style: {
                  padding: '6px 0',
                  color:
                    estopState.state === 'ready'
                      ? 'var(--dsw-alias-state-success-primary, #2e9e4f)'
                      : 'var(--dsw-alias-state-error-primary)',
                },
                children:
                  estopState.state === 'ready'
                    ? t('playEstopReady')
                    : t('playEstopStopped') + (estopState.lastReason ? `（${estopState.lastReason}）` : ''),
              }),
              estopState.state === 'ready' ? '' : t('playEstopResumeHint'),
            ),
          ],
        }),

        estopState.state === 'ready'
          ? null
          : h('div', {
              className: 'dsh-whale-girl-cfg__actions',
              children: [
                h('button', {
                  type: 'button',
                  className: 'dsh-whale-girl-cfg__btn',
                  onClick: () => void resume(),
                  children: t('playResume'),
                }),
              ],
            }),

        // ── 游戏档案：她怎么玩这款游戏 ──
        // 视觉模型只看像素，不可能自己知道「W 是前进」。键位与要点必须外部给。
        h('h3', { className: 'dsh-whale-girl-cfg__title', children: t('gameTitle') }),
        h('p', { className: 'dsh-whale-girl-cfg__note', children: t('gameHint') }),
        h('div', {
          className: 'dsh-whale-girl-cfg__grid2',
          children: [
            field(
              t('gameNameLabel'),
              h('input', {
                type: 'text',
                className: inputClass,
                value: gameTitle,
                placeholder: '群星',
                onChange: (e: ChangeEvent<HTMLInputElement>) => {
                  setGameTitle(e.target.value);
                  setStatus('idle');
                },
              }),
              t('gameNameHint'),
            ),
            field(
              t('gameGenreLabel'),
              h('select', {
                className: inputClass,
                value: gameGenre,
                onChange: (e: ChangeEvent<HTMLSelectElement>) => {
                  setGameGenre(e.target.value);
                  setStatus('idle');
                },
                children: [
                  ['turn-based', t('gameGenreTurn')],
                  ['grand-strategy', t('gameGenreStrategy')],
                  ['tactics', t('gameGenreTactics')],
                  ['rpg', t('gameGenreRpg')],
                  ['action', t('gameGenreAction')],
                  ['custom', t('gameGenreCustom')],
                ].map(([v, label]) => h('option', { key: v, value: v, children: label })),
              }),
              t('gameGenreHint'),
            ),

        // 记忆容量：类型旁边直接显示预设值，也允许这款游戏单独覆盖
        field(
          t('gameCapLabel'),
          h('input', {
            type: 'number',
            className: inputClass,
            min: 20,
            max: 20000,
            value: gameCap,
            placeholder: String(genreCaps[gameGenre] ?? 500),
            onChange: (e: ChangeEvent<HTMLInputElement>) => {
              setGameCap(e.target.value);
              setStatus('idle');
            },
          }),
          t('gameCapHint') + '（' + t('gameCapPreset') + ': ' + String(genreCaps[gameGenre] ?? 500) + ' 步）',
        ),
          ],
        }),
        field(
          t('gameKeysLabel'),
          h('textarea', {
            className: inputClass,
            rows: 4,
            value: gameKeys,
            placeholder: '暂停=space\n加速=a\n确认=enter',
            onChange: (e: ChangeEvent<HTMLTextAreaElement>) => {
              setGameKeys(e.target.value);
              setStatus('idle');
            },
          }),
          t('gameKeysHint'),
        ),
        field(
          t('gameNotesLabel'),
          h('textarea', {
            className: inputClass,
            rows: 3,
            value: gameNotes,
            placeholder: '前期优先科研\n注意人口增长',
            onChange: (e: ChangeEvent<HTMLTextAreaElement>) => {
              setGameNotes(e.target.value);
              setStatus('idle');
            },
          }),
          t('gameNotesHint'),
        ),
        // 保存档案 / 联网查攻略
        h('div', {
          className: 'dsh-whale-girl-cfg__actions',
          children: [
            h('button', {
              type: 'button',
              className: 'dsh-whale-girl-cfg__btn',
              onClick: () => void saveGame(),
              children: t('gameSave'),
            }),
            h('button', {
              type: 'button',
              className: 'dsh-whale-girl-cfg__btn',
              disabled: guideBusy,
              onClick: () => void lookupGuide(),
              children: guideBusy ? t('gameGuideBusy') : t('gameGuide'),
            }),
            gameMsg === '' ? null : h('span', { className: 'dsh-whale-girl-cfg__note', children: gameMsg }),
          ],
        }),

        // ── 本局进度 + 结束本局 ──
        h('h3', { className: 'dsh-whale-girl-cfg__title', children: t('sessionTitle') }),
        h('p', { className: 'dsh-whale-girl-cfg__note', children: sessionText }),
        h('div', {
          className: 'dsh-whale-girl-cfg__actions',
          children: [
            h('button', {
              type: 'button',
              className: 'dsh-whale-girl-cfg__btn',
              onClick: () => void endSession(),
              children: t('sessionEnd'),
            }),
          ],
        }),

        // 窗口白名单

        // 窗口白名单
        field(
          t('playWindows'),
          h('textarea', {
            className: inputClass,
            rows: 3,
            value: windowTitles,
            placeholder: '星露谷物语\n群星',
            onChange: (e: ChangeEvent<HTMLTextAreaElement>) => {
              setWindowTitles(e.target.value);
              setStatus('idle');
            },
          }),
          t('playWindowsHint'),
        ),

        // 从「正在运行的窗口」点选：不用手打标题，也不会把中文名写成窗口里不存在的字符串
        h('div', {
          className: 'dsh-whale-girl-cfg__actions',
          children: [
            h('select', {
              className: inputClass,
              value: '',
              onChange: (e: ChangeEvent<HTMLSelectElement>) => {
                const title = e.target.value;
                if (title === '') return;
                setWindowTitles((prev) => {
                  const lines = prev
                    .split('\n')
                    .map((s) => s.trim())
                    .filter((s) => s !== '');
                  if (!lines.includes(title)) lines.push(title);
                  return lines.join('\n');
                });
                setStatus('idle');
              },
              children: [
                h('option', { value: '', children: t('playPickWindow') }),
                ...windowChoices.map((w) =>
                  h('option', {
                    key: String(w.pid ?? w.title) + '|' + w.title,
                    value: w.title,
                    children: w.title + (w.processName !== undefined && w.processName !== '' ? '（' + w.processName + '）' : ''),
                  }),
                ),
              ],
            }),
            h('button', {
              type: 'button',
              className: 'dsh-whale-girl-cfg__btn',
              onClick: () => void refreshWindowChoices(),
              children: t('playRefreshWindows'),
            }),
          ],
        }),

        // 当前前台窗口（方便复制标题进白名单）
        h('div', {
          className: 'dsh-whale-girl-cfg__actions',
          children: [
            h('button', {
              type: 'button',
              className: 'dsh-whale-girl-cfg__btn',
              onClick: () => {
                void (async () => {
                  try {
                    const res = await fetch('/dsh-whale-girl/autoplay/foreground');
                    const data = (await res.json()) as { title?: string };
                    setFg(data.title ?? '');
                  } catch {
                    setFg('');
                  }
                })();
              },
              children: t('playCheckWindow'),
            }),
            // 一键把当前前台窗口标题写进白名单：中文游戏名和英文窗口标题对不上时，
            // 这是最省事、也最不会填错的做法（主人踩过：填「苏丹的游戏」，窗口叫 Sultan's Game）
            h('button', {
              type: 'button',
              className: 'dsh-whale-girl-cfg__btn',
              onClick: () => {
                void (async () => {
                  try {
                    const res = await fetch('/dsh-whale-girl/autoplay/foreground');
                    const data = (await res.json()) as { title?: string };
                    const title = (data.title ?? '').trim();
                    if (title === '') return;
                    setWindowTitles((prev) => {
                      const lines = prev
                        .split('\n')
                        .map((s) => s.trim())
                        .filter((s) => s !== '');
                      if (!lines.includes(title)) lines.push(title);
                      return lines.join('\n');
                    });
                    setStatus('idle');
                  } catch {
                    /* 宿主不可达：保持原样 */
                  }
                })();
              },
              children: t('playAddWindow'),
            }),
            fg === '' ? null : h('span', { className: 'dsh-whale-girl-cfg__note', children: `「${fg}」` }),
          ],
        }),

        // 开始 / 停止陪玩：真正的「她自己一局一局玩下去」
        h('div', {
          className: 'dsh-whale-girl-cfg__actions',
          children: [
            h('button', {
              type: 'button',
              className: 'dsh-whale-girl-cfg__btn',
              disabled: busyNow,
              onClick: () => void (playing ? stopPlay() : startPlay()),
              children: playing ? t('playStop') : t('playStart'),
            }),
            playing ? h('span', { className: 'dsh-whale-girl-cfg__note', children: t('playLoopOn') }) : null,
          ],
        }),

        // 跑一轮（保存交给顶部的统一按钮）
        h('div', {
          className: 'dsh-whale-girl-cfg__actions',
          children: [
            h('button', {
              type: 'button',
              className: 'dsh-whale-girl-cfg__btn',
              disabled: busyNow,
              onClick: () => void runOnce(),
              children: running ? t('playRunning') : t('playRunNow'),
            }),
            status === 'saved' ? h('span', { className: 'dsh-whale-girl-cfg__note', children: t('sightSaved') }) : null,
            status === 'error'
              ? h('span', {
                  className: 'dsh-whale-girl-cfg__note',
                  style: { color: 'var(--dsw-alias-state-error-primary)' },
                  children: errText,
                })
              : null,
          ],
        }),

        // 动作日志
        h('p', { className: 'dsh-whale-girl-cfg__note', children: t('playLog') }),
        log.length === 0
          ? h('p', { className: 'dsh-whale-girl-cfg__note', children: t('playLogEmpty') })
          : h('div', {
              style: {
                marginTop: '6px',
                maxHeight: '180px',
                overflowY: 'auto',
                fontFamily: MONO,
                fontSize: '12px',
                lineHeight: 1.6,
                background: 'rgba(0,0,0,.18)',
                borderRadius: '6px',
                padding: '8px',
              },
              children: log.map((line, i) => h('div', { key: i, children: line })),
            }),
      ],
    });
  };

  return function PetConfigSection() {
    const initPets = petBridge.current.filter((p) => !p.extra);
    // 文件定义宠物数量（pet/ 目录，不在本编辑列表；仅展示提示）
    const extraCount = petBridge.current.filter((p) => p.extra).length;
    const [pets, setPets] = useState<Pet[]>(initPets.map((p) => ({ ...p, position: { ...p.position } })));
    const [selId, setSelId] = useState<string>(initPets[0]?.id ?? '');
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
    const [page, setPage] = useState<'pet' | 'look' | 'voice' | 'log' | 'sight' | 'play' | 'more'>('pet');
    /** 按页签过滤：不属于当前页就返回 null（而不是不渲染——保持元素结构稳定） */
    const only = (
      target: typeof page,
      node: ReturnType<typeof h> | null,
    ): ReturnType<typeof h> | null => (page === target ? node : null);
    const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
    const [loadAttempt, setLoadAttempt] = useState(0);

    /**
     * 四个模块的保存函数登记表。
     *
     * 为什么用登记：四块配置存在**四个不同文件**（main-config / voice.json /
     * sight.json / autoplay.json），字段形状也完全不同。硬把状态提到这里，
     * 这个组件会变成一个巨型 state 容器。登记让每块自己管表单，只把
     * 「怎么保存」交出去，顶部一个按钮统一触发。
     */
    const saversRef = useRef<Map<string, () => Promise<string | null>>>(new Map());
    const registerSave = useCallback((name: string, fn: (() => Promise<string | null>) | null) => {
      if (fn === null) saversRef.current.delete(name);
      else saversRef.current.set(name, fn);
    }, []);
    /** 顶部「保存全部」的状态与汇总信息 */
    const [saveAll, setSaveAll] = useState<{ kind: 'idle' | 'saving' | 'ok' | 'err'; text: string }>({
      kind: 'idle',
      text: '',
    });

    /**
     * 一次保存全部四份配置：宠物 / 语音 / 识屏 / 代打。
     *
     * 四个模块各自登记了自己的保存函数（见 saversRef），这里按顺序调一遍。
     * 任一处失败都**继续保存其余部分**（能存的先存上），最后把失败原因汇总显示——
     * 中途 abort 会让前面已经算好的改动白做。
     */
    const runSaveAll = async (): Promise<void> => {
      setSaveAll({ kind: 'saving', text: '' });
      const failures: string[] = [];
      try {
        const err = await save();
        if (err !== null) failures.push(`宠物配置：${err}`);
      } catch (e) {
        failures.push(`宠物配置：${e instanceof Error ? e.message : String(e)}`);
      }
      for (const [name, fn] of saversRef.current) {
        try {
          const err = await fn();
          if (err !== null) failures.push(`${name}：${err}`);
        } catch (e) {
          failures.push(`${name}：${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (failures.length === 0) setSaveAll({ kind: 'ok', text: t('saveAllDone') });
      else setSaveAll({ kind: 'err', text: failures.join('；') });
    };
    const busy = saving || loadState !== 'ready';
    const [msg, setMsg] = useState<{ kind: 'ok' | 'err' | ''; text: string }>({ kind: '', text: '' });
    // 确认/提示弹窗（仿官方弹窗：遮罩 + 居中卡片 + 按钮）：
    //   remove  —— 删除宠物（双按钮：取消 / 删除）
    //   lastOne —— 只剩一只、删不了：同样走弹窗（单按钮「知道了」）。
    //              以前这里是在按钮旁闪一行红字——位置在页面中段、颜色又淡，很容易被忽略，
    //              用户只看到「点了删除没反应」。
    //   sync    —— 同步（说明会用内置默认整份覆盖）
    //   corrupt —— 保存时发现用户配置**已损坏**（解析不了）：取消 = 不动文件，确认 = 强行白名单重建
    const [dialog, setDialog] = useState<
      null | { kind: 'remove' } | { kind: 'lastOne' } | { kind: 'sync' } | { kind: 'corrupt'; path: string }
    >(null);
    // 配置文件地址与存储位置清单（「高级配置」「卸载与存储」区块；读取失败仅缺省不显示，不影响表单）
    const [paths, setPaths] = useState<null | {
      user: string;
      default: string;
      animations: string;
      /** 用户表情包目录（$DSH_HOME/dsh-whale-girl/memes：加图不必改包） */
      memes?: string;
      /** 插件落盘的全部位置（路径 + 是否已存在），host 按平台推导 */
      storage?: Array<{ key: string; path: string; exists?: boolean }>;
      /** 当前 profile 名（拼卸载命令用；反推不出时为空串） */
      profile?: string;
    }>(null);
    useEffect(() => {
      fetch('/dsh-whale-girl/config/meta')
        .then((r) => (r.ok ? r.json() : null))
        .then((p) => setPaths(p))
        .catch(() => console.warn('[dsh-whale-girl] 读取配置文件路径失败'));
    }, []);

    // 系统通知总开关（全局：写用户级配置 main-config.jsonc 的 notificationsEnabled）。
    // 与其余三个全局开关**完全同构**：切换只改本地 UI 状态，随「保存」一起整包写入。
    // 为什么不做即时写入：PUT /config 会触发宿主重启桌面 Helper（全部桌面宠物窗口重建——
    // 拖拽落点清空、宠物跳回配置角落），于是"改个通知开关，桌面被重置"，与其它开关行为不一致。
    // 引擎重读放在 save() 成功之后（reloadNotifications）：保存后即时生效，无需刷新页面。
    const [notifyEnabled, setNotifyEnabled] = useState(true);
    // 表情包配图开关（全局：写用户级配置；与「保存」一起提交，不做即时写入）
    const [whisperImage, setWhisperImage] = useState(false);
    const [chatImage, setChatImage] = useState(false);
    // 抛掷锁定开关（全局：写用户级配置；与「保存」一起提交，不做即时写入）
    const [confineScreen, setConfineScreen] = useState(false);
    // 物理参数（全局：拖拽抛掷手感，写用户级配置 main-config.jsonc 的 physics 段）。
    // 与四个开关同一套语义：只改本地状态，随「保存」整包写入（不做即时写入）。
    // 初值仅作占位；成品配置加载成功后才允许编辑和保存。
    const [physics, setPhysics] = useState<PhysicsParams>({ ...DEFAULT_PHYSICS });
    // 字体（全局默认：字体种类 / 字号 / 是否随宠物大小缩放，写用户级配置的 font 段）。
    // 与四个全局开关 / physics 同一套语义：只改本地状态，随「保存」整包写入（不做即时写入）。
    // 初值仅作占位；成品配置加载成功后才允许编辑和保存。
    const [font, setFont] = useState<FontConfig>({ ...DEFAULT_FONT });
    // AI 模型（条目级：碎碎念 / 对话各自的服务商 + 模型，两者都留空 = 跟随当前对话的模型）。
    // 与四个全局开关同一套语义：只改本地状态，随「保存」整包写入（不做即时写入）。
    const [whisperModel, setWhisperModel] = useState<ModelSelection>({ provider: '', model: '' });
    const [chatModel, setChatModel] = useState<ModelSelection>({ provider: '', model: '' });
    // 对话历史条数（全局默认：每次对话请求带多少历史进上下文，写用户级配置的 chatMemoryRounds）。
    // 与两个模型 / 四个开关同一套语义：只改本地状态，随「保存」整包写入（不做即时写入）。
    // 初值 5 = 内置默认（assets/config.jsonc）；下面的加载效应会用成品 main.chatMemoryRounds 覆盖。
    const [chatMemory, setChatMemory] = useState(5);
    // 对话配图张数上限（全局默认：对话时发给模型的表情包清单最多几张，写用户级配置的 chatImageLimit）。
    // 同上：只改本地状态，随「保存」整包写入。初值 10 = 内置默认（砍掉整张清单的约 2/3 开销）；
    // 加载效应会用成品 main.chatImageLimit 覆盖。
    const [chatImageLimit, setChatImageLimit] = useState(10);
    // 候选清单（GET /models：宿主 llm 服务的实时服务商 + 各自模型，与 DSH 的模型选择器同源）。
    // null = 还没拉到（下拉框只剩「跟随当前对话」）；拉失败置 catalogErr 显示一行提示。
    const [catalog, setCatalog] = useState<ModelCatalogGroup[] | null>(null);
    const [catalogErr, setCatalogErr] = useState(false);
    // 权限申请按钮的反馈（就地显示在按钮旁，与全局保存反馈分离）
    const [permMsg, setPermMsg] = useState<{ kind: 'ok' | 'err' | ''; text: string }>({ kind: '', text: '' });
    // 首次读取与恢复默认必须更新同一组控件，避免下一次保存回写过期值。
    const applyConfig = useCallback((merged: Record<string, Record<string, unknown>>) => {
      const m = merged.main;
      if (!m || !Array.isArray(m.pets)) throw new Error('Invalid config response');
      const loadedPets = m.pets as Pet[];
      setPets(loadedPets.map((p) => ({ ...p, position: { ...p.position } })));
      setSelId((id) => (loadedPets.some((p) => p.id === id) ? id : (loadedPets[0]?.id ?? '')));
      if (typeof m.notificationsEnabled === 'boolean') setNotifyEnabled(m.notificationsEnabled);
      if (typeof m.whisperImageEnabled === 'boolean') setWhisperImage(m.whisperImageEnabled);
      if (typeof m.chatImageEnabled === 'boolean') setChatImage(m.chatImageEnabled);
      if (typeof m.confineToScreen === 'boolean') setConfineScreen(m.confineToScreen);
      // physics 段：成品已按「内置默认 ← 用户层」整段填满，直接取用（缺子键再用默认兜底一次）
      if (m.physics && typeof m.physics === 'object') {
        setPhysics({ ...DEFAULT_PHYSICS, ...(m.physics as PhysicsParams) });
      }
      // 字体段：同 physics——成品已填满，缺子键再用默认兜底一次
      if (m.font && typeof m.font === 'object') {
        setFont({ ...DEFAULT_FONT, ...(m.font as FontConfig) });
      }
      // 模型选择：成品同样已填满（内置默认 = 两者都空 = 跟随当前对话），读得出就原样上屏
      const wm = m.whisperModel as Partial<ModelSelection> | undefined;
      if (wm && typeof wm.provider === 'string' && typeof wm.model === 'string') {
        setWhisperModel({ provider: wm.provider, model: wm.model });
      }
      const cm = m.chatModel as Partial<ModelSelection> | undefined;
      if (cm && typeof cm.provider === 'string' && typeof cm.model === 'string') {
        setChatModel({ provider: cm.provider, model: cm.model });
      }
      // 对话历史条数：成品同样已填满（内置默认 5 ← 用户层），合法就原样上屏
      const cmr = Number(m.chatMemoryRounds);
      if (Number.isFinite(cmr) && cmr >= 0) setChatMemory(cmr);
      // 对话配图张数上限：同上（内置默认 0 = 不限制）
      const cil = Number(m.chatImageLimit);
      if (Number.isFinite(cil) && cil >= 0) setChatImageLimit(cil);
    }, []);

    useEffect(() => {
      let alive = true;
      const controller = new AbortController();
      fetch('/dsh-whale-girl/config', { signal: controller.signal })
        .then((r) => {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .then((merged) => {
          if (!alive) return;
          applyConfig(merged);
          setLoadState('ready');
        })
        .catch(() => {
          if (alive) setLoadState('error');
        });
      return () => {
        alive = false;
        controller.abort();
      };
    }, [applyConfig, loadAttempt]);

    // 候选模型清单：一次性拉取（下拉框数据源）。失败只提示、不阻塞——已有配置值照常显示与保存。
    useEffect(() => {
      let alive = true;
      fetch('/dsh-whale-girl/models')
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
        .then((d) => {
          if (!alive) return;
          if (d && Array.isArray(d.providers)) setCatalog(d.providers as ModelCatalogGroup[]);
          else setCatalogErr(true);
        })
        .catch(() => {
          if (alive) setCatalogErr(true);
        });
      return () => {
        alive = false;
      };
    }, []);

    // 切换系统通知：与配图/抛掷锁定开关同构——只改本地状态（开启时顺带借这次用户手势申请权限），
    // 配置在点「保存」时整包写入；保存成功后由 save() 调 reloadNotifications() 让引擎即时重读。
    const toggleNotify = async (v: boolean) => {
      setNotifyEnabled(v);
      // 开启时借用户手势申请系统通知权限（无手势的自动申请可能被浏览器静默压制）
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
      setPermMsg({ kind: '', text: '' });
      const r = await requestNotificationPermission();
      if (!r.ok) {
        // 红字：失败理由 + 引导（unsupported 无引导，改环境才有意义）
        const reason =
          r.reason === 'unsupported'
            ? t('notifyDenyUnsupported')
            : r.reason === 'denied'
              ? t('notifyDenyBlocked')
              : r.reason === 'rejected'
                ? t('notifyDenyRejected')
                : t('notifyDenyError') + (r.message ? '：' + r.message : '');
        setPermMsg({ kind: 'err', text: reason + (r.reason === 'unsupported' ? '' : ' ' + t('notifyGuide')) });
        return;
      }
      try {
        // 成功即发一条测试通知验证链路（绕过聚焦门，直接确认）
        new Notification('测试通知', { body: '【dsh-whale-girl】系统通知已就绪。', icon: NOTIFY_ICONS.test });
      } catch {
        /* 个别环境构造失败：仍按已授权提示 */
      }
      setPermMsg({ kind: 'ok', text: t('notifyTestOk') });
    };

    // 当前选中的宠物对象（表单数据源）；selId 由 add/remove/sync 同步维护，列表非空时恒有效
    const cur = pets.find((p) => p.id === selId) ?? null;

    // 更新选中的宠物：size 走顶层；position 子字段整体替换
    const updateSel = (patch: Partial<Omit<Pet, 'position'>> & { position?: Partial<Pet['position']> }) =>
      setPets((list) =>
        list.map((p) => {
          if (p.id !== selId) return p;
          const { position: posPatch, ...rest } = patch;
          return { ...p, ...rest, position: posPatch ? { ...p.position, ...posPatch } : p.position };
        }),
      );

    const validated = (): boolean => {
      for (const p of pets) {
        if (
          !Number.isFinite(p.size) ||
          p.size <= 0 ||
          !Number.isFinite(p.position.marginX) ||
          !Number.isFinite(p.position.marginY)
        ) {
          setMsg({ kind: 'err', text: t('invalid') });
          return false;
        }
      }
      // 物理参数：与宿主 physicsValid 同一套规则（非法宿主会回 400，这里先就地给红字提示）
      if (
        !Number.isFinite(physics.gravity) ||
        physics.gravity < 0 ||
        !Number.isFinite(physics.restitution) ||
        physics.restitution < 0 ||
        physics.restitution > 1 ||
        !Number.isFinite(physics.groundFriction) ||
        physics.groundFriction < 0 ||
        !Number.isFinite(physics.throwPower) ||
        physics.throwPower <= 0
      ) {
        setMsg({ kind: 'err', text: t('invalidPhysics') });
        return false;
      }
      // 模型选择：与宿主 modelSelectionValid 同一套规则——只填一半（选了服务商没选模型，或反之）非法
      if (!modelPairValid(whisperModel) || !modelPairValid(chatModel)) {
        setMsg({ kind: 'err', text: t('invalidModel') });
        return false;
      }
      // 对话历史条数：与宿主 topFieldValid 同一套规则（有限且 ≥ 0）
      if (!Number.isFinite(chatMemory) || chatMemory < 0) {
        setMsg({ kind: 'err', text: t('invalidChatMemory') });
        return false;
      }
      // 对话配图张数上限：同上（0 = 不限制，合法）
      if (!Number.isFinite(chatImageLimit) || chatImageLimit < 0) {
        setMsg({ kind: 'err', text: t('invalidChatImageLimit') });
        return false;
      }
      // 字体：与宿主 fontValid 同一套规则（family 必须在预设白名单内、size 4~200、followPet 为布尔）
      if (
        !FONT_PRESETS.some((p) => p.id === font.family) ||
        !Number.isFinite(font.size) ||
        font.size < FONT_SIZE_MIN ||
        font.size > FONT_SIZE_MAX
      ) {
        setMsg({ kind: 'err', text: t('invalidFont') });
        return false;
      }
      return true;
    };

    // force 只认严格 true：**绝不能**写成 `force ? ...`——保存按钮现在是包一层再调 save，
    // 但历史上是把这个 handler 直接交给 React 的 onClick，于是 React 把 MouseEvent 当第一个
    // 实参传进来 → 真值 → 每次都拼上 ?force=1 → 宿主的损坏预检被绕过 →
    // 静默白名单重建、字段全丢、永不弹窗（真实事故，已由源码守卫钉住）。
    /** 保存宠物配置。返回错误信息（null = 成功），供顶部「保存全部」汇总 */
    const save = async (force = false): Promise<string | null> => {
      if (busy) return '正在保存中';
      const isOk = validated();
      if (!isOk) return '宠物配置有误，请检查红字提示';
      setBusy(true);
      setMsg({ kind: '', text: '' });
      try {
        // 通知总开关随保存一起写：UI 状态初始来自成品 main 条目（即保留用户手写值，不会静默覆盖）
        const body: Record<string, unknown> = {
          pets: pets,
          notificationsEnabled: notifyEnabled,
          whisperImageEnabled: whisperImage,
          chatImageEnabled: chatImage,
          confineToScreen: confineScreen,
          // 物理参数整段提交（白名单字段，未传即走宿主透传保留）：宿主用 physicsValid 整段校验
          physics: physics,
          // 碎碎念 / 对话的模型（条目级白名单字段，同上）：宿主用 modelSelectionValid 整段校验，
          // 两者都空 = 跟随当前对话的模型
          whisperModel: whisperModel,
          chatModel: chatModel,
          // 对话历史条数（全局默认白名单字段）：宿主用 topFieldValid 校验（有限且 ≥ 0）
          chatMemoryRounds: chatMemory,
          // 对话配图张数上限（同上；0 = 不限制）
          chatImageLimit: chatImageLimit,
          // 字体（全局默认白名单字段）：宿主用 fontValid 整段校验（family 白名单 / size 4~200 /
          // followPet 布尔）；传了就整段写进用户层，没传则透传保留磁盘旧值
          font: font,
        };
        // force === true（用户在损坏弹窗里点了确认）：带 ?force=1 才允许按白名单重建损坏文件
        const res = await fetch('/dsh-whale-girl/config' + (force === true ? '?force=1' : ''), {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        // 409 = 宿主损坏预检拦下（用户配置解析不了，白名单重建会把文件里剩下的内容整份丢掉）：
        // 这里**不写盘**，弹窗让用户决定（取消 = 不动文件 / 确认 = 强行重建）
        if (res.status === 409) {
          // 路径取宿主回的真实写入路径（meta 拉取失败时也不至于空着）
          const info = (await res.json().catch(() => null)) as { userFile?: unknown } | null;
          setDialog({
            kind: 'corrupt',
            path: typeof info?.userFile === 'string' ? info.userFile : (paths?.user ?? ''),
          });
          return '配置文件损坏，需要你确认后重建';
        }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        // 同上：PUT 响应即成品聚合，容器据此重新拍平（新增/删除宠物、改大小位置都走这条路）
        petBridge.reload((await res.json()) as Record<string, Record<string, unknown>>);
        void reloadNotifications(); // 通知引擎重读开关：保存后即时生效，无需刷新页面
        setMsg({ kind: 'ok', text: t('saved') });
        return null;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setMsg({ kind: 'err', text: t('loadError') });
        return message;
      } finally {
        setBusy(false);
      }
    };

    const sync = () => setDialog({ kind: 'sync' });

    const doSync = async () => {
      setBusy(true);
      setMsg({ kind: '', text: '' });
      try {
        // 同步用户层：POST 把内置默认配置（原文，含注释）整份写入用户配置，响应体同样是成品聚合
        // （此时 main 条目 = 内置默认宠物列表），与保存走同一条路——不再"改完再拉一次"，
        // 也就没有中间失败态
        const res = await fetch('/dsh-whale-girl/config', { method: 'POST' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const merged = (await res.json()) as Record<string, Record<string, unknown>>;
        applyConfig(merged);
        // 同一份成品交给容器拍平：编辑列表（裸实例）与渲染列表（含条目级字段）都由成品派生
        petBridge.reload(merged);
        void reloadNotifications();
        setMsg({ kind: 'ok', text: t('saved') });
        return null;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setMsg({ kind: 'err', text: t('loadError') });
        return message;
      } finally {
        setBusy(false);
      }
    };

    const addPet = () => {
      const tpl = petBridge.template;
      if (!tpl) return;
      const id = nextId(pets);
      setPets((list) => [
        ...list,
        {
          id,
          // 新宠物默认名字 = 自己的新 id（与「缺失 name 按 id 处理」同一语义，避免继承模板名字造成同名）
          name: id,
          size: tpl.size,
          balanceEnabled: tpl.balanceEnabled,
          whisperEnabled: tpl.whisperEnabled,
          workStatusEnabled: tpl.workStatusEnabled,
          fixedEnabled: tpl.fixedEnabled,
          display: tpl.display,
          position: { ...tpl.position },
        },
      ]);
      setSelId(id);
    };

    const removeSel = () => {
      // 两种情形都走弹窗：能删 → 确认删除；只剩一只 → 说明删不了。
      // 不再把「至少保留一个宠物」塞进按钮旁的消息行（那里离删除按钮很远，等于没提示）。
      setDialog({ kind: pets.length <= 1 ? 'lastOne' : 'remove' });
    };

    const doRemove = () => {
      const list = pets.filter((p) => p.id !== selId);
      setPets(list);
      setSelId(list[0].id);
    };

    /** 宠物数值输入（大小 / 水平偏移 / 垂直偏移）——宽度交给栅格，不再各自写死 */
    const numInput = (
      key: 'size' | 'marginX' | 'marginY',
      value: number,
      setter: (v: number) => void,
    ): ReturnType<typeof h> =>
      h('input', {
        type: 'number',
        className: inputClass,
        step: key === 'size' ? '10' : '1',
        min: key === 'size' ? '120' : '',
        value: String(value),
        disabled: busy,
        onChange: (e: ChangeEvent<HTMLInputElement>) => setter(Number(e.target.value)),
      });

    /** 物理参数的一格：标签 + 问号在上、数字输入在下（说明进问号） */
    const physField = (
      key: 'gravity' | 'restitution' | 'groundFriction' | 'throwPower',
      step: string,
      min: string,
      end = false,
    ): ReturnType<typeof h> =>
      field(
        t('physics.' + key),
        h('input', {
          type: 'number',
          className: inputClass,
          step,
          min,
          value: String(physics[key]),
          disabled: busy,
          onChange: (e: ChangeEvent<HTMLInputElement>) =>
            setPhysics((p) => ({ ...p, [key]: Number(e.target.value) }) as PhysicsParams),
        }),
        t('physics.' + key + 'Hint'),
        end,
      );

    /** 「全局默认」的一个数字格：标签 + 问号在上、数字输入在下（说明 = t(label + 'Hint') 进问号） */
    const globalNumField = (label: string, value: number, setter: (v: number) => void): ReturnType<typeof h> =>
      field(
        t(label),
        h('input', {
          type: 'number',
          className: inputClass,
          step: '1',
          min: '0',
          value: String(value),
          disabled: busy,
          onChange: (e: ChangeEvent<HTMLInputElement>) => setter(Number(e.target.value)),
        }),
        t(label + 'Hint'),
      );

    /** 「AI 模型」的一格：标签 + 问号在上、单下拉选择器在下 */
    const modelCell = (
      key: 'whisperModel' | 'chatModel',
      value: ModelSelection,
      setter: (v: ModelSelection) => void,
      end = false,
    ): ReturnType<typeof h> => {
      const label = t(key === 'whisperModel' ? 'whisperModelLabel' : 'chatModelLabel');
      return field(
        label,
        h(ModelPicker, { label, value, disabled: busy, catalog, failed: catalogErr, onChange: setter }),
        t('modelFieldHint'),
        end,
      );
    };

    return h('section', {
      className: 'dsh-whale-girl-cfg',
      style: { maxWidth: '720px' },
      children: [
        // 标题：intro 与「额外宠物」说明都收进问号，不再各占一行小字
        h('h2', {
          className: 'dsh-whale-girl-cfg__title',
          children: [
            t('nav'),
            q(extraCount > 0 ? t('intro') + '\n' + t('extraPetsHint').replace('{n}', String(extraCount)) : t('intro')),
          ],
        }),

        // ── 置顶操作条：**全页唯一的保存入口** ──
        //
        // 为什么置顶并吸顶：设置页现在已经分成 6 个页签 + 4 份配置文件，
        // 原来每块各有一个「保存」按钮，改完还得滚到对应位置找它对的那个。
        // 现在一个按钮保存全部四份，位置固定在标题下方，滚到哪都看得见。
        h('div', {
          className: 'dsh-whale-girl-cfg__saveBar',
          children: [
            h('button', {
              type: 'button',
              disabled: busy || saveAll.kind === 'saving',
              onClick: () => void runSaveAll(),
              className: 'dsh-whale-girl-cfg__btn is-primary',
              children: saveAll.kind === 'saving' ? t('saving') : t('saveAll'),
            }),
            saveAll.text === ''
              ? null
              : h('span', {
                  className:
                    'dsh-whale-girl-cfg__msg' + (saveAll.kind === 'err' ? ' is-err' : ''),
                  children: saveAll.text,
                }),
            // 提示这四份配置会一起写盘（避免有人以为只存当前页）
            h('span', { className: 'dsh-whale-girl-cfg__note', children: t('saveAllHint') }),
          ],
        }),

        // ── 统一模型（置顶，始终可见）──
        //
        // 为什么放在页签之上：文字对话 / 语音对话 / 看屏幕搭话 / 代打**共用同一个模型**，
        // 它是全局口径而不是某一页的设置。放在最前面，主人一眼看到「现在是哪家在跑」，
        // 也不用为了改模型在几个页签之间来回切（之前分成两处，改一边另一边不跟，正是这个毛病）。
        h('div', {
          className: 'dsh-whale-girl-cfg__card',
          children: [
            cardHead(t('modelTitle'), t('modelHint')),
            catalogErr
              ? h('p', {
                  className: 'dsh-whale-girl-cfg__note',
                  style: { color: 'var(--dsw-alias-state-error-primary)' },
                  children: t('modelCatalogFailed'),
                })
              : null,
            h('div', {
              className: 'dsh-whale-girl-cfg__grid2',
              children: [
                modelCell('whisperModel', whisperModel, setWhisperModel),
                modelCell('chatModel', chatModel, setChatModel, true),
              ],
            }),
            h('p', { className: 'dsh-whale-girl-cfg__note', children: t('modelSharedHint') }),
            h('div', {
              className: 'dsh-whale-girl-cfg__grid4',
              children: [
                globalNumField('chatMemory', chatMemory, setChatMemory),
                globalNumField('chatImageLimit', chatImageLimit, setChatImageLimit),
              ],
            }),
          ],
        }),

        // 页签：把内容分页显示，每页只显示相关的（否则要滚很久）
        h('div', {
          className: 'dsh-whale-girl-cfg__pageTabs',
          role: 'tablist',
          children: (['pet', 'look', 'voice', 'log', 'sight', 'play', 'more'] as const).map((id) =>
            h('button', {
              key: id,
              type: 'button',
              role: 'tab',
              'aria-selected': page === id,
              className: 'dsh-whale-girl-cfg__pageTab' + (page === id ? ' is-active' : ''),
              onClick: () => setPage(id),
              children: t('page_' + id),
            }),
          ),
        }),

        loadState !== 'ready'
          ? h('div', {
              role: loadState === 'error' ? 'alert' : 'status',
              className: 'dsh-whale-girl-cfg__actions',
              children: [
                h('span', { children: t(loadState === 'error' ? 'loadError' : 'loading') }),
                loadState === 'error'
                  ? h('button', {
                      type: 'button',
                      className: 'dsh-whale-girl-cfg__btn',
                      onClick: () => {
                        setLoadState('loading');
                        setLoadAttempt((attempt) => attempt + 1);
                      },
                      children: t('retry'),
                    })
                  : null,
              ],
            })
          : null,

        // 宠物列表 + 添加
        only('pet', h('div', {
          className: 'dsh-whale-girl-cfg__tabs',
          children: [
            h('span', { key: 'label', className: 'dsh-whale-girl-cfg__tabsLabel', children: t('petsLabel') }),
            ...pets.map((p) =>
              h('button', {
                key: p.id,
                type: 'button',
                onClick: () => setSelId(p.id),
                className: 'dsh-whale-girl-cfg__tab' + (p.id === selId ? ' is-active' : ''),
                children: (p.name || p.id) + ' (' + p.size + 'px)',
              }),
            ),
            h('button', {
              key: 'add',
              type: 'button',
              onClick: addPet,
              disabled: busy,
              className: 'dsh-whale-girl-cfg__tab is-ghost',
              children: '+ ' + t('add'),
            }),
          ],
        })),

        // 选中宠物配置卡：第 1 行 名字/大小/显示位置、第 2 行 位置/偏移、第 3 行 四个开关
        only('pet', cur
          ? h('div', {
              className: 'dsh-whale-girl-cfg__card',
              children: [
                h('div', {
                  className: 'dsh-whale-girl-cfg__cardHead',
                  children: [
                    h('span', { key: 't', className: 'dsh-whale-girl-cfg__cardTitle', children: t('petCardTitle') }),
                    q(t('petCardHint')),
                    h('button', {
                      key: 'rm',
                      type: 'button',
                      onClick: removeSel,
                      disabled: busy,
                      className: 'dsh-whale-girl-cfg__btn is-danger is-sm',
                      style: { marginLeft: 'auto' },
                      children: t('remove'),
                    }),
                  ],
                }),

                h('div', {
                  className: 'dsh-whale-girl-cfg__grid3',
                  children: [
                    field(
                      t('nameLabel'),
                      h('input', {
                        type: 'text',
                        className: inputClass,
                        value: String(cur.name ?? ''),
                        disabled: busy,
                        maxLength: 50,
                        onChange: (e: ChangeEvent<HTMLInputElement>) => updateSel({ name: e.target.value }),
                      }),
                      t('nameHint'),
                    ),
                    field(
                      t('sizeLabel'),
                      numInput('size', cur.size, (v) => updateSel({ size: v })),
                      t('sizeHint'),
                    ),
                    field(
                      t('displayLabel'),
                      h('select', {
                        className: inputClass,
                        value: cur.display,
                        disabled: busy,
                        onChange: (e: ChangeEvent<HTMLSelectElement>) =>
                          updateSel({ display: e.target.value as PetDisplay }),
                        children: PET_DISPLAYS.map((d) =>
                          h('option', {
                            key: d,
                            value: d,
                            children: t('display.' + d),
                          }),
                        ),
                      }),
                      t('displayHint'),
                      true,
                    ),
                  ],
                }),

                h('div', {
                  className: 'dsh-whale-girl-cfg__grid3',
                  children: [
                    field(
                      t('cornerLabel'),
                      h('select', {
                        className: inputClass,
                        value: cur.position.corner,
                        disabled: busy,
                        onChange: (e: ChangeEvent<HTMLSelectElement>) =>
                          updateSel({ position: { corner: e.target.value as Corner } }),
                        children: CORNERS.map((c) =>
                          h('option', {
                            key: c,
                            value: c,
                            children: cornerLabel(c),
                          }),
                        ),
                      }),
                      t('cornerHint'),
                    ),
                    field(
                      t('marginX'),
                      numInput('marginX', cur.position.marginX, (v) => updateSel({ position: { marginX: v } })),
                      t('marginXHint'),
                    ),
                    field(
                      t('marginY'),
                      numInput('marginY', cur.position.marginY, (v) => updateSel({ position: { marginY: v } })),
                      t('marginYHint'),
                      true,
                    ),
                  ],
                }),

                h('div', {
                  className: 'dsh-whale-girl-cfg__grid4',
                  children: [
                    toggleCell('balanceEnabled', !!cur.balanceEnabled, busy, (v) => updateSel({ balanceEnabled: v })),
                    toggleCell('whisperEnabled', !!cur.whisperEnabled, busy, (v) => updateSel({ whisperEnabled: v })),
                    toggleCell('workStatusEnabled', !!cur.workStatusEnabled, busy, (v) =>
                      updateSel({ workStatusEnabled: v }),
                    ),
                    toggleCell('fixedEnabled', !!cur.fixedEnabled, busy, (v) => updateSel({ fixedEnabled: v }), true),
                  ],
                }),
              ],
            })
          : h('p', {
              className: 'dsh-whale-girl-cfg__note',
              children: t('emptyPets'),
            })),

        // 全局开关卡（需求 4：四个开关一行）。
        // 四个开关行为**一致**：切换只改本地状态，随「保存」整包写入用户级配置——不做即时写入
        // （即时写盘会触发宿主重启桌面 Helper，把全部桌面宠物窗口重建一遍）。系统通知额外在保存后
        // 由 save() 调 reloadNotifications() 让通知引擎即时重读。
        // 「测试弹窗」按钮不在这里——它是个动作，跟「保存 / 同步」同一行（见下面的操作区）。
        only('look', h('div', {
          className: 'dsh-whale-girl-cfg__card',
          children: [
            cardHead(t('globalTitle'), t('globalHint')),
            h('div', {
              className: 'dsh-whale-girl-cfg__grid4',
              children: [
                toggleCell('notifyToggle', notifyEnabled, busy, (v) => void toggleNotify(v)),
                toggleCell('whisperImageToggle', whisperImage, busy, setWhisperImage),
                toggleCell('chatImageToggle', chatImage, busy, setChatImage),
                toggleCell('confineToggle', confineScreen, busy, setConfineScreen, true),
              ],
            }),
          ],
        })),

        // 外观与字体卡：字体种类 + 字号 + 是否随宠物缩放（全局默认，与全局开关 / physics 同语义——
        // 只改本地状态，随「保存」整包写入用户配置；不做即时写入）。
        // 字体种类的作用范围 = 现在用软糖体的全部地方（气泡 / 悬浮提示 / 对话窗 / 得分弹窗）；
        // 字号**只**作用于气泡与悬浮提示（对话窗与得分弹窗的字号不随本项变，故不在此列）。
        only('look', h('div', {
          className: 'dsh-whale-girl-cfg__card',
          children: [
            cardHead(t('fontTitle'), t('fontHint')),
            h('div', {
              className: 'dsh-whale-girl-cfg__grid2',
              children: [
                field(
                  t('fontFamilyLabel'),
                  h('select', {
                    className: inputClass,
                    value: font.family,
                    disabled: busy,
                    onChange: (e: ChangeEvent<HTMLSelectElement>) =>
                      setFont((f) => ({ ...f, family: e.target.value as FontFamilyId })),
                    children: FONT_PRESETS.map((p) =>
                      h('option', { key: p.id, value: p.id, children: t('font.' + p.id) }),
                    ),
                  }),
                  t('fontFamilyHint'),
                ),
                field(
                  t('fontSizeLabel'),
                  h('input', {
                    type: 'number',
                    className: inputClass,
                    step: '1',
                    min: String(FONT_SIZE_MIN),
                    max: String(FONT_SIZE_MAX),
                    value: String(font.size),
                    disabled: busy,
                    onChange: (e: ChangeEvent<HTMLInputElement>) =>
                      setFont((f) => ({ ...f, size: Number(e.target.value) })),
                  }),
                  t('fontSizeHint'),
                  true,
                ),
              ],
            }),
            h('div', {
              className: 'dsh-whale-girl-cfg__grid2',
              children: [
                toggleCell('fontFollowToggle', font.followPet, busy, (v) => setFont((f) => ({ ...f, followPet: v }))),
              ],
            }),
          ],
        })),

        // 语音卡：快捷键与音色（即时保存，不参与底部「保存」——见 VoiceSettingsCard 的注释）
        // 三张模块卡**始终挂载**（切页只用 display 隐藏）：only() 会把它们卸载，
        // 那样没打开过的页签的保存函数就没登记，「保存全部」会漏掉它们。
        h('div', {
          key: 'voice',
          style: { display: page === 'voice' ? 'contents' : 'none' },
          children: [h(VoiceSettingsCard, { key: 'voice-card', registerSave }), h(MemoryPersonaCard, { key: 'memory-card' })],
        }),

        h('div', {
          key: 'log',
          style: { display: page === 'log' ? 'contents' : 'none' },
          children: h(ChatLogCard, {}),
        }),

        // 识屏卡：默认全关，开启后才截图（权限感必须写在界面上）
        h('div', {
          key: 'sight',
          style: { display: page === 'sight' ? 'contents' : 'none' },
          children: h(SightSettingsCard, { registerSave }),
        }),

        // 代打卡：默认空跑，确认逻辑无误后才允许真注入
        h('div', {
          key: 'play',
          style: { display: page === 'play' ? 'contents' : 'none' },
          children: h(AutoplaySettingsCard, { registerSave }),
        }),

        // 物理卡（需求 6）：四个数字输入一行 + 两个开关一行。
        // 与上面四个开关同一套语义（只改本地状态，随「保存」整包写入；不做即时写入）。
        // 浏览器保存后即时生效；桌面端由保存触发的 Helper 重启重新读取——physics 在 sprite 构造时只读一次。
        only('look', h('div', {
          className: 'dsh-whale-girl-cfg__card',
          children: [
            cardHead(t('physicsTitle'), t('physicsHint')),
            h('div', {
              className: 'dsh-whale-girl-cfg__grid4',
              children: [
                physField('gravity', '50', '0'),
                physField('restitution', '0.01', '0'),
                physField('groundFriction', '0.1', '0'),
                physField('throwPower', '0.05', '0.05', true),
              ],
            }),
            h('div', {
              className: 'dsh-whale-girl-cfg__grid2',
              children: [
                toggleCell('physicsCeilingBounce', physics.ceilingBounce, busy, (v) =>
                  setPhysics((p) => ({ ...p, ceilingBounce: v })),
                ),
                toggleCell(
                  'physicsPetCollision',
                  physics.petCollision,
                  busy,
                  (v) => setPhysics((p) => ({ ...p, petCollision: v })),
                  true,
                ),
              ],
            }),
          ],
        })),

        // 操作区：「测试弹窗」与「保存 / 同步」同一行（都是动作）；「同步」的副作用说明收进问号
        h('div', {
          className: 'dsh-whale-girl-cfg__actions',
          children: [
            h('button', {
              type: 'button',
              disabled: busy,
              onClick: sync,
              className: 'dsh-whale-girl-cfg__btn',
              children: t('sync'),
            }),
            h('button', {
              type: 'button',
              onClick: () => void testNotification(),
              className: 'dsh-whale-girl-cfg__btn',
              children: t('notifyTest'),
            }),
            q(t('syncHint')),
            // 两个反馈各归各的：msg = 保存/同步结果，permMsg = 测试通知结果
            msg.text
              ? h('span', {
                  className: 'dsh-whale-girl-cfg__msg' + (msg.kind === 'err' ? ' is-err' : ''),
                  children: msg.text,
                })
              : null,
            permMsg.text
              ? h('span', {
                  className: 'dsh-whale-girl-cfg__msg' + (permMsg.kind === 'err' ? ' is-err' : ''),
                  children: permMsg.text,
                })
              : null,
          ],
        }),

        // 高级配置（文件地址）：供高级用户直接编辑配置文件自定义；说明收进问号
        only('more', h(AppsCard, { key: 'apps' })),
        only('more', paths
          ? h('div', {
              className: 'dsh-whale-girl-cfg__card',
              children: [
                cardHead(t('configMeta'), t('configMetaHint')),
                h('div', { className: 'dsh-whale-girl-cfg__path', children: t('defaultConfig') + '：' + paths.default }),
                h('div', { className: 'dsh-whale-girl-cfg__path', children: t('userConfig') + '：' + paths.user }),
                h('div', { className: 'dsh-whale-girl-cfg__path', children: t('animationDir') + '：' + paths.animations }),
                paths.memes
                  ? h('div', { className: 'dsh-whale-girl-cfg__path', children: t('memesDir') + '：' + paths.memes })
                  : null,
              ],
            })
          : null),

        // 卸载与存储：先列出插件落盘的全部位置（路径在前、作用在后），再给出卸载方法；说明收进问号
        only('more', paths && paths.storage && paths.storage.length > 0
          ? h('div', {
              className: 'dsh-whale-girl-cfg__card',
              children: [
                cardHead(t('storageTitle'), t('storageHint')),
                // 存储位置清单：每条都是「路径（等宽、可选中复制）→ 作用」
                ...paths.storage.map((s) =>
                  h('div', {
                    key: s.key,
                    className: 'dsh-whale-girl-cfg__path',
                    children: [
                      h('b', { key: 'p', style: { fontFamily: MONO }, children: s.path }),
                      // 尚未产生的目录（如从未启用桌面模式的 Electron）标一下，避免用户去找不存在的文件夹
                      h('span', {
                        key: 'd',
                        children: ' — ' + t('storage.' + s.key) + (s.exists === false ? t('storageMissing') : ''),
                      }),
                    ],
                  }),
                ),
                h('div', {
                  key: 'ut',
                  className: 'dsh-whale-girl-cfg__cardTitle',
                  style: { marginTop: '4px' },
                  children: t('uninstallTitle'),
                }),
                h('div', { key: 'u1', className: 'dsh-whale-girl-cfg__note', children: t('uninstallStep1') }),
                h('div', { key: 'u2', className: 'dsh-whale-girl-cfg__note', children: t('uninstallStep2') }),
                h('div', {
                  key: 'cmd',
                  className: 'dsh-whale-girl-cfg__cmd',
                  children: t('uninstallCmd').replace('{profile}', paths.profile || '<profile>'),
                }),
                h('div', { key: 'u3', className: 'dsh-whale-girl-cfg__note', children: t('uninstallStep3') }),
              ],
            })
          : null),

        // 确认/提示弹窗（仿官方弹窗视觉：遮罩 + 居中卡片 + 按钮）
        dialog
          ? h('div', {
              style: {
                position: 'fixed',
                inset: 0,
                zIndex: 2147483647,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'rgba(0, 0, 0, 0.45)',
              },
              onClick: () => setDialog(null),
              children: h('div', {
                style: {
                  width: '340px',
                  maxWidth: 'calc(100vw - 40px)',
                  background: 'var(--dsw-alias-bg-layer-1)',
                  border: '1px solid var(--dsw-alias-border-l2)',
                  borderRadius: '12px',
                  padding: '16px 18px',
                  boxShadow: '0 8px 30px rgba(0, 0, 0, 0.35)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '12px',
                },
                onClick: (e: ReactNS.MouseEvent<HTMLDivElement>) => e.stopPropagation(),
                children: [
                  h('div', {
                    style: { fontSize: '14px', fontWeight: 500, color: 'var(--dsw-alias-label-primary)' },
                    children: dialog.kind === 'corrupt' ? t('corruptTitle') : t('confirmTitle'),
                  }),
                  h('div', {
                    style: { fontSize: '13px', lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' },
                    children:
                      dialog.kind === 'remove'
                        ? t('confirmRemove').replace('{id}', selId)
                        : dialog.kind === 'lastOne'
                          ? t('atLeastOne')
                          : dialog.kind === 'corrupt'
                            ? t('corruptBody').replace('{path}', dialog.path)
                            : t('confirmSync'),
                  }),
                  h('div', {
                    style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' },
                    // 只剩一只 = 没有可确认的动作，只给一个「知道了」；其余都是 取消 + 确认 双按钮
                    children:
                      dialog.kind === 'lastOne'
                        ? [
                            h('button', {
                              key: 'ok',
                              type: 'button',
                              onClick: () => setDialog(null),
                              className: 'dsh-whale-girl-cfg__btn is-primary',
                              children: t('ok'),
                            }),
                          ]
                        : [
                            h('button', {
                              key: 'cancel',
                              type: 'button',
                              onClick: () => setDialog(null),
                              className: 'dsh-whale-girl-cfg__btn',
                              children: t('cancel'),
                            }),
                            h('button', {
                              key: 'confirm',
                              type: 'button',
                              onClick: () => {
                                const d = dialog;
                                setDialog(null);
                                if (d.kind === 'remove') doRemove();
                                else if (d.kind === 'corrupt')
                                  void save(true); // 确认：带 ?force=1 强行重建
                                else void doSync();
                              },
                              className: 'dsh-whale-girl-cfg__btn ' + (dialog.kind === 'sync' ? 'is-primary' : 'is-danger'),
                              children:
                                dialog.kind === 'remove'
                                  ? t('remove')
                                  : dialog.kind === 'corrupt'
                                    ? t('corruptConfirm')
                                    : t('sync'),
                            }),
                          ],
                  }),
                ],
              }),
            })
          : null,
      ],
    });
  };
}
