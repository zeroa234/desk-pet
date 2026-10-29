// store/：存档读写的对外出口（R8.9、R9.4，design.md §12）。别的模块只 import 这个文件。
export type {SaveData} from './save.ts';
export {emptySave, loadSave, writeSave, offlineSeconds, OFFLINE_CAP_SEC} from './save.ts';
