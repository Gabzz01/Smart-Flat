import spidev, time, pigpio, os, sys

# This script transmits and nothing else. The caller owns both the virtual remote ID and its
# rolling code; the bridge keeps them in its Matter storage, alongside everything else that must
# survive a restart. Two owners of one counter is the one thing a rolling code cannot have.
#
#   SOMFY_ADDR=0x123457 SOMFY_ROLL=42 python3 somfy-tx.py up
#
# It prints `next=43`, the code to send with the following frame.
ADDR_TEXT = os.environ.get("SOMFY_ADDR", "0x123457")   # virtual remote's ID — any 3 bytes
ADDR = tuple((int(ADDR_TEXT, 16) >> s) & 0xFF for s in (16, 8, 0))
GDO0 = int(os.environ.get("SOMFY_GDO0", 25))   # TX data pin (the jumper)
CMD = {"my":0x1, "up":0x2, "down":0x4, "prog":0x8}

spi = spidev.SpiDev(); spi.open(0,0); spi.max_speed_hz=1_000_000; spi.mode=0
def strobe(c): spi.xfer2([c])
def wreg(a,v): spi.xfer2([a&0x3F, v])

def cc1101_tx_setup():
    strobe(0x30); time.sleep(0.05)                       # reset
    for a,v in [(0x02,0x2D),   # IOCFG0 -> GDO0 = async serial data IN (TX)
                (0x08,0x32),   # PKTCTRL0 async serial
                (0x0B,0x06),   # FSCTRL1
                (0x0D,0x10),(0x0E,0xAB),(0x0F,0x8F),     # 433.42 MHz
                (0x12,0x30),   # MDMCFG2 = OOK
                (0x18,0x18),   # MCSM0 autocal
                (0x22,0x11),   # FREND0 = OOK PA
                (0x23,0xE9),(0x24,0x2A),(0x25,0x00),(0x26,0x1F),
                (0x2C,0x81),(0x2D,0x35),(0x2E,0x09)]:
        wreg(a,v)
    spi.xfer2([0x3E|0x40, 0x00, 0xC0])                   # PATABLE: off=0x00, on=0xC0

def encode_halfsyms(key,cmd,roll,addr):
    fr=[key,(cmd<<4),(roll>>8)&0xFF,roll&0xFF,addr[0],addr[1],addr[2]]
    c=0
    for b in fr: c^=(b&0xF)^(b>>4)
    fr[1]|=(c&0xF)                                        # checksum
    obf=[fr[0]]+[0]*6
    for i in range(1,7): obf[i]=fr[i]^obf[i-1]            # obfuscate
    bits=[(b>>(7-j))&1 for b in obf for j in range(8)]    # MSB first
    hs=[]
    for bit in bits: hs += [0,1] if bit==1 else [1,0]     # Manchester: 1 = low->high
    return hs

def frame_pulses(hs, hw_sync):
    p=[]
    for _ in range(hw_sync): p += [(1,2416),(0,2416)]     # hardware sync
    p += [(1,4550),(0,604)]                               # software sync
    lvl=hs[0]; run=1
    for x in hs[1:]:
        if x==lvl: run+=1
        else: p.append((lvl,run*604)); lvl=x; run=1
    p.append((lvl,run*604))
    p.append((0,30415))                                   # inter-frame gap
    return p

def build_tx(hs, repeats):
    p=[(1,9415),(0,89565)]                                # wake-up
    p += frame_pulses(hs, 2)                              # first frame: 2 sync
    for _ in range(repeats): p += frame_pulses(hs, 7)     # repeats: 7 sync
    return p

def send(pulses):
    pi=pigpio.pi()
    if not pi.connected: raise SystemExit("pigpiod not running: sudo pigpiod")
    pi.set_mode(GDO0, pigpio.OUTPUT); pi.write(GDO0,0)
    wf=[pigpio.pulse(1<<GDO0,0,d) if l else pigpio.pulse(0,1<<GDO0,d) for l,d in pulses]
    pi.wave_clear(); pi.wave_add_generic(wf); wid=pi.wave_create()
    strobe(0x35); time.sleep(0.002)                       # CC1101 -> TX
    pi.wave_send_once(wid)
    while pi.wave_tx_busy(): time.sleep(0.005)
    pi.wave_delete(wid); strobe(0x36)                     # -> IDLE
    pi.write(GDO0,0); pi.stop()

def read_roll():
    v = os.environ.get("SOMFY_ROLL")
    if v is None: raise SystemExit("SOMFY_ROLL is required: the caller owns the rolling code")
    try: r = int(v)
    except ValueError: raise SystemExit(f"SOMFY_ROLL must be a number, got {v!r}")
    # The frame carries it in 16 bits, and a shutter only accepts codes ahead of the last it saw.
    if not 1 <= r <= 0xFFFF: raise SystemExit(f"SOMFY_ROLL must be 1..65535, got {r}")
    return r

def command(name, repeats=2):
    roll=read_roll(); key=0xA0 | (roll & 0x0F)
    cc1101_tx_setup()
    send(build_tx(encode_halfsyms(key, CMD[name], roll, ADDR), repeats))
    # next= is what the caller persists. Printed only after the frame is out of the radio.
    print(f"sent {name}: addr={ADDR_TEXT} roll={roll} key=0x{key:02X} next={roll+1}")

if __name__=="__main__":
    command(sys.argv[1] if len(sys.argv)>1 else "prog",
            int(sys.argv[2]) if len(sys.argv)>2 else 2)
