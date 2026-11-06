import {useEffect,useRef,useState} from 'react';

type SearchState<T>={key:string;status:'IDLE'|'LOADING'|'READY'|'ERROR';items:T[]};
/** A completed snapshot is reused across keystrokes and clear/reopen within this exact context. */
export function useCompleteNameSearch<T>(active:boolean,key:string,load:(signal:AbortSignal)=>Promise<T[]>){
 const cache=useRef<{key:string;items:T[]}|null>(null);
 const [state,setState]=useState<SearchState<T>>({key,status:'IDLE',items:[]});
 const [revision,setRevision]=useState(0);
 useEffect(()=>{
  if(cache.current?.key!==key)cache.current=null;
  if(!active)return;
  if(cache.current){setState({key,status:'READY',items:cache.current.items});return;}
  const controller=new AbortController();setState({key,status:'LOADING',items:[]});
  void load(controller.signal).then(items=>{
   if(!controller.signal.aborted){cache.current={key,items};setState({key,status:'READY',items});}
  }).catch(()=>{if(!controller.signal.aborted)setState({key,status:'ERROR',items:[]});});
  return()=>controller.abort();
 },[active,key,load,revision]);
 return {...(state.key===key?state:{key,status:'IDLE' as const,items:[]}),retry:()=>{cache.current=null;setRevision(value=>value+1);}};
}
