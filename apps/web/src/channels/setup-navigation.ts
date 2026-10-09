// Navigation context only: the server still authorizes every box read and mutation.
export function channelSetupNavigation(search:string){
 const channelId=new URLSearchParams(search).get('channel');
 const valid=channelId&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(channelId)?channelId:null;
 return {suffix:valid?`?channel=${encodeURIComponent(valid)}`:'',channelPath:valid?`/channels/${encodeURIComponent(valid)}`:null};
}
