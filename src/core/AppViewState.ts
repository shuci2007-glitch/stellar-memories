import type {Memory,Photo,ViewMode} from './types';
export type AppViewState = {
  mainView: ViewMode;
  content: 'overview'|'album_focus'|'photo_focus'|'photo_detail'|'story';
  detail: {photo:Photo;memory:Memory}|null;
  exiting: boolean;
  albumId: number|null;
  mapPhotoId?: number|null;
};
export const initialViewState: AppViewState={mainView:'galaxy',content:'overview',detail:null,exiting:false,albumId:null};
export function navigateView(state:AppViewState, mainView:ViewMode, albumId:number|null=null):AppViewState {
  return {...state,mainView,content:albumId===null?'overview':'album_focus',detail:null,exiting:false,albumId};
}
