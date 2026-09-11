import {ipc} from './db';
export const AUTH_SETTINGS_EVENT='album-auth-settings-changed';
export async function publishAuthSettings(){
 const state=await ipc.authState();
 window.dispatchEvent(new CustomEvent(AUTH_SETTINGS_EVENT,{detail:state}));
 return state;
}
