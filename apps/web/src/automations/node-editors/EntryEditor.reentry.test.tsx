// @vitest-environment jsdom
import {fireEvent,render,screen} from '@testing-library/react';
import {describe,it,expect,vi} from 'vitest';
import {EntryEditor} from './EntryEditor';

describe('explicit attendance policies',()=>{
 it('keeps both policies off until the flow administrator selects them',()=>{
  const onChange=vi.fn();
  render(<EntryEditor editable node={{id:'start',type:'start',label:'Start',position:{x:0,y:0},data:{entryConfigVersion:1,trigger:'MESSAGE_RECEIVED',reentry:'ALWAYS'}}} onChange={onChange}/>);
  const navigation=screen.getByRole('checkbox',{name:'Permitir voltar ao menu anterior (0 ou voltar)'});
  const restart=screen.getByRole('checkbox',{name:'Novo atendimento após resolver no JRC'});
  expect(navigation).not.toBeChecked();expect(restart).not.toBeChecked();
  fireEvent.click(navigation);expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({menuNavigationVersion:1}));
  fireEvent.click(restart);expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({restartAfterResolution:true}));
 });
});
