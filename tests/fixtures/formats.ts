export const svgFixture = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="red"/></svg>')
const frame = '21f90400140000002c0000000001000100000202440100'
export const gifFixture = Buffer.from('47494638396101000100800000000000ffffff' + frame + frame + '3b', 'hex')
