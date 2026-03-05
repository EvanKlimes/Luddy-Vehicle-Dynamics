// Slip angle computation helpers
// Exposes global functions: computeBetaBasic(state), computeBetaDynamic(state, vy), computeBetaPred(state, minVxForAlpha)

window.computeBetaBasic = function(state){
  if(!state) return [];
  if(!Array.isArray(state.vy_body) || !Array.isArray(state.vx_body)) return [];
  return state.vy_body.map((vy,i)=>{ const vx = state.vx_body[i] || 1e-3; return Math.atan2(vy||0, vx); });
}

window.computeBetaDynamic = function(state, vy){
  if(!state || !Array.isArray(vy)) return [];
  return vy.map((v,i)=> Math.atan2(v, Math.max(0.1, Math.abs((state.vx && state.vx[i]) || 1))));
}

window.computeBetaPred = function(state, minVxForAlpha){
  const n = (state && state.t && state.t.length) ? state.t.length : 0;
  const beta_pred = new Array(n).fill(NaN);
  if(!state || !state.vx || !state.alpha_f || !state.alpha_r) return beta_pred;
  // initialize
  let vy_pred = (state.vy_body && isFinite(state.vy_body[0]))? state.vy_body[0] : 0;
  let r_pred = (state.yaw_rate && isFinite(state.yaw_rate[0]))? state.yaw_rate[0] : 0;
  for(let i=0;i<n-1;i++){
    const dt = (state.t[i+1]-state.t[i]) || 0.01;
    const vx_i = Math.max(minVxForAlpha, Math.abs((state.vx && state.vx[i]) || (state.vx_body && state.vx_body[i]) || minVxForAlpha));
    const delta = (state.steer && isFinite(state.steer[i])) ? state.steer[i] : 0;
    const alpha_f_pred = delta - Math.atan2( (vy_pred + r_pred*(state.vehicle && state.vehicle.lf || 0)), vx_i );
    const alpha_r_pred = - Math.atan2( (vy_pred - r_pred*(state.vehicle && state.vehicle.lr || 0)), vx_i );
    const Fyf = 2 * (state.vehicle && state.vehicle.Cf || 0) * alpha_f_pred;
    const Fyr = 2 * (state.vehicle && state.vehicle.Cr || 0) * alpha_r_pred;
    const vy_dot = ( -vx_i * r_pred + ( -Fyf - Fyr ) / (state.vehicle && state.vehicle.m || 1) );
    const r_dot = ( (-(state.vehicle && state.vehicle.lf || 0) * Fyf + (state.vehicle && state.vehicle.lr || 0) * Fyr) / (state.vehicle && state.vehicle.Iz || 1) );
    vy_pred = vy_pred + vy_dot * dt;
    r_pred = r_pred + r_dot * dt;
    beta_pred[i+1] = Math.atan2(vy_pred, vx_i);
  }
  return beta_pred;
}
