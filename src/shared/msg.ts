// 界面消息（2026-10-29 双语）：运行时模块（LLM、看屏幕、勿扰……）只产出“词条键 + 参数”，界面按当前语言翻译（src/shared/i18n.ts）。
// 纯数据、不 import i18next：模块之间只靠这个约定，运行时模块不知道界面用什么语言。
export interface Msg {
  key: string;
  params?: Record<string, string | number>;
}

export const msg = (key: string, params?: Msg['params']): Msg => params ? {key, params} : {key};
