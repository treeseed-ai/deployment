export class RetainedPlanningTests {
    protected static retained(value:{kind:string}):boolean{return value.kind==='retain';}
    protected static retire(value:{kind:string}):boolean{return value.kind==='retire';}
    
}
