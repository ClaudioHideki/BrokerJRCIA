// @vitest-environment jsdom
import {fireEvent,render,screen} from '@testing-library/react';
import {expect,it,vi} from 'vitest';
import {SimulationWaitControl} from './SimulationWaitControl.js';
it('allows advancing virtual time after 100 replies in the bounded replay',()=>{
 const advance=vi.fn();
 render(<SimulationWaitControl clock="2030-01-01T00:00:00Z" wakeAt="2030-01-01T00:00:05Z" events={Array.from({length:100},()=>({type:'MESSAGE',text:'x'}))} disabled={false} onAdvance={advance}/>);
 const button=screen.getByRole('button',{name:'Avançar até o fim da espera'});
 expect(button).toBeEnabled();fireEvent.click(button);expect(advance).toHaveBeenCalledWith(5);
});
