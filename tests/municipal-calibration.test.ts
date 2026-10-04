import {it,expect} from 'vitest';
import {calibratedMonthlyExpense,calibrationOf} from '../src/core/municipal-calibration';
import {createGame,applyCommand} from '../src/core/commands';
import {monthlyBudget,policyOf} from '../src/core/simulation';
import {decodeSave,encodeSave} from '../src/core/snapshot';
import baseline from './fixtures/rules4-economy.json';
import {quoteAction} from '../src/core/quote';
import {intentFrom} from '../src/world/permissions';
import {describeChange} from '../src/world/changes';
import {blank,command} from './fixtures/world';
const calibration={version:1 as const,territoryId:'Q24639',fiscalYear:2026,annualOperatingCad:1200000,population:1000,gameUnitsPerCad:.01,source:{dataset:'Synthetic test',url:'https://example.org',territoryId:'Q24639',retrievedAt:'2026-10-02T00:00:00Z',observedYear:2026,method:'reported' as const}};
it('uses annual per capita monthly reference',()=>expect(calibratedMonthlyExpense(100,calibration)).toBe(100));
it('explicit action keeps cash debt and tax',()=>{const s=createGame('test',1,blank());const r=applyCommand(s,command(s,{type:'municipal-calibration',calibration}),[]);expect(r.status).toBe('applied');expect(r.state.money).toBe(s.money);expect(policyOf(r.state)).toEqual(policyOf(s));expect(calibrationOf(r.state)).toEqual(calibration);});
it('rejects invalid capture',()=>{const s=createGame('test',1,blank());expect(applyCommand(s,command(s,{type:'municipal-calibration',calibration:{...calibration,population:0}}),[]).status).toBe('rejected');});
it('offline save replay matches',()=>{const s=createGame('test',1,blank());const c=command(s,{type:'municipal-calibration',calibration});const a=applyCommand(s,c,[]).state;const decoded=decodeSave(encodeSave({version:1,state:s,view:{x:0,y:0,zoom:1,speed:0,place:'Vancouver'}})).state;expect(JSON.stringify(applyCommand(decoded,c,[]).state)).toBe(JSON.stringify(a));});
it('old save has no automatic calibration and identical monthly ledger',()=>{const s=createGame('test',1,blank());const raw={version:1,state:{...s,rulesVersion:4},view:{x:0,y:0,zoom:1,speed:0,place:'Vancouver'}};const opened=decodeSave(raw).state;expect(opened.rulesVersion).toBe(5);expect(calibrationOf(opened)).toBeNull();expect(monthlyBudget(opened)).toEqual(monthlyBudget(s));});
it('removing calibration restores baseline',()=>{const s=createGame('test',1,blank());const a=applyCommand(s,command(s,{type:'municipal-calibration',calibration}),[]).state;const b=applyCommand(a,command(a,{type:'municipal-calibration',calibration:null}),[]).state;expect(calibrationOf(b)).toBeNull();expect(monthlyBudget(b)).toEqual(monthlyBudget(s));});

it('rules 4 ledger remains exactly unchanged without calibration',()=>{const state=decodeSave({version:1,state:baseline.state,view:{x:0,y:0,zoom:1,speed:0,place:'test'}}).state;expect(monthlyBudget(state)).toEqual({revenue:144,expense:144,net:0});expect(monthlyBudget(state)).toEqual(baseline.monthly);});
it('quotes and serializes the action and preserves project intent',()=>{const s=createGame('test',1,blank());const action={type:'municipal-calibration' as const,calibration};expect(quoteAction(s,action,[])).toEqual({status:'ok',cost:0});expect(intentFrom(action)).toMatchObject({ok:true,value:action});const cmd=command(s,action);const after=applyCommand(s,cmd,[]).state;expect(describeChange(s,cmd,after).operations[0].intent).toEqual({kind:'municipal-calibration',calibration});});

it('calibration replaces resident service reference while retaining service factors',()=>{const state=decodeSave({version:1,state:baseline.state,view:{x:0,y:0,zoom:1,speed:0,place:'test'}}).state;const a=applyCommand(state,command(state,{type:'municipal-calibration',calibration}),[]).state;expect(monthlyBudget(a)).toEqual({revenue:144,expense:8,net:136});const b=applyCommand(a,command(a,{type:'policy',services:150}),[]).state;expect(monthlyBudget(b)).toEqual({revenue:144,expense:12,net:132});});

it('explicit_calibration_confirmation_contains_ratio_year_currency_and_source',async()=>{const {municipalCalibrationPreview}=await import('../src/presentation/words');const preview=municipalCalibrationPreview({id:'Q24639',label:'Vancouver',population:1000,populationYear:2021,source:{dataset:'fixture',url:'https://example.test',license:'fixture'},finance:{territoryId:'Q24639',fiscalYear:2026,status:'approved-budget',operating:{value:1200000,unit:'CAD',source:calibration.source}}});for(const expected of ['2026','CAD 1.200.000','0,01 unidades/CAD','2021','https://example.org'])expect(preview).toContain(expected);expect(municipalCalibrationPreview(null)).toContain('indisponível');});
