import type {GameState} from './model';
import type {MeasureSource} from './municipal-facts';
export type MunicipalCalibration={version:1;territoryId:string;fiscalYear:number;annualOperatingCad:number;population:number;gameUnitsPerCad:number;source:MeasureSource};
export function validCalibration(value:unknown):value is MunicipalCalibration{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const c=value as MunicipalCalibration;const s=c.source;
 return c.version===1&&typeof c.territoryId==='string'&&/^Q\d+$/.test(c.territoryId)&&Number.isInteger(c.fiscalYear)&&c.fiscalYear>=1900&&c.fiscalYear<=2200&&Number.isFinite(c.annualOperatingCad)&&c.annualOperatingCad>0&&c.annualOperatingCad<=1e15&&Number.isSafeInteger(c.population)&&c.population>0&&Number.isFinite(c.gameUnitsPerCad)&&c.gameUnitsPerCad>0&&c.gameUnitsPerCad<=1&&!!s&&s.territoryId===c.territoryId&&s.observedYear===c.fiscalYear&&s.method==='reported'&&typeof s.dataset==='string'&&typeof s.url==='string'&&typeof s.retrievedAt==='string';
}
export function calibrationOf(state:GameState):MunicipalCalibration|null{
 const c=state.components['city.economy']?.calibration;return validCalibration(c)?c:null;
}
export function calibratedMonthlyExpense(population:number,calibration:MunicipalCalibration):number{
 return Math.round(population*calibration.annualOperatingCad/calibration.population/12*calibration.gameUnitsPerCad);
}
