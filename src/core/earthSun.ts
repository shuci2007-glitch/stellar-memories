/** NOAA solar-position approximation, UTC; independent of the viewing direction.
 * https://gml.noaa.gov/grad/solcalc/solareqns.PDF
 */
export function earthSun(date = new Date()): [number,number,number] {
  const year=date.getUTCFullYear(),start=Date.UTC(year,0,1);
  const day=(date.getTime()-start)/86400000;
  const days=(Date.UTC(year+1,0,1)-start)/86400000;
  const gamma=2*Math.PI/days*(day-.5);
  const equation=229.18*(.000075+.001868*Math.cos(gamma)-.032077*Math.sin(gamma)-.014615*Math.cos(2*gamma)-.040849*Math.sin(2*gamma));
  const declination=.006918-.399912*Math.cos(gamma)+.070257*Math.sin(gamma)-.006758*Math.cos(2*gamma)+.000907*Math.sin(2*gamma)-.002697*Math.cos(3*gamma)+.00148*Math.sin(3*gamma);
  const minutes=date.getUTCHours()*60+date.getUTCMinutes()+date.getUTCSeconds()/60+date.getUTCMilliseconds()/60000;
  const longitude=(180-(minutes+equation)/4)*Math.PI/180;
  return [Math.cos(declination)*Math.cos(longitude),Math.sin(declination),-Math.cos(declination)*Math.sin(longitude)];
}
