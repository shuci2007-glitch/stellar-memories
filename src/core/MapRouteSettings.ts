import {ipc} from './db';
export const MAP_ROUTE_SETTINGS_EVENT='map-photo-routes-changed';
const key='map_photo_routes_enabled';
export async function loadMapRoutesEnabled(){const stored=await ipc.getSetting(key);return stored!=='false'&&stored!=='0';}
export async function saveMapRoutesEnabled(enabled:boolean){
 await ipc.setSetting(key,String(enabled));
 window.dispatchEvent(new CustomEvent(MAP_ROUTE_SETTINGS_EVENT,{detail:enabled}));
}
