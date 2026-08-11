import json, sys
import numpy as np, matplotlib
matplotlib.use("Agg"); import matplotlib.pyplot as plt
sys.path.insert(0, "figs")
from src.style import use, SET2, MUTED, INK

d=json.load(open("figs/out/fig5_rear_coupling_2animal.json")); use()
C={"near":SET2[1],"far":SET2[2],"null":MUTED}
LB={"near":f"near (< {d['near_bl']:.0f} body lengths apart)","far":"far","null":"circular-shift null"}
fig,axes=plt.subplots(1,2,figsize=(9.4,3.6),constrained_layout=True)
for ax,c in zip(axes,["BMimica","SLAP-2M"]):
    s=d["corpora"][c]; t=np.asarray(s["t"])
    for key in ("near","far","null"):
        g=s[key]
        if not g: continue
        lw=2.2 if key!="null" else 1.2
        ls=":" if key=="null" else "-"
        if key!="null":
            ax.fill_between(t,g["p25"],g["p75"],color=C[key],alpha=0.16,lw=0)
        ax.plot(t,g["p50"],color=C[key],lw=lw,ls=ls,
                label=f"{LB[key]}" + (f"  (n={s['n_onsets'][key]:,})" if key!="null" else ""))
    ax.axhline(1.0,color=INK,lw=0.7,ls="--",alpha=0.5)
    ax.axvline(0,color=INK,lw=0.8,ls="--",alpha=0.5)
    z=int(np.argmin(np.abs(t))); mu=np.asarray(s["near"]["p50"])
    ax.annotate(f"{mu[z]:.2f}× chance",(0,mu[z]),textcoords="offset points",
                xytext=(8,6),color=C["near"],fontweight="bold",fontsize=8)
    ax.set_xlabel("lag from the other animal's rear onset (s)")
    ax.set_ylabel("P(rearing) / chance")
    ax.set_title(f"{c} — {s['n_sessions']} sessions, 2 animals",fontweight="bold")
    ax.legend(frameon=False,fontsize=7,loc="upper right")
    ax.set_ylim(0.6,2.6)
    nq,fq=np.asarray(s["near_q"]["p50"])[z],np.asarray(s["far_q"]["p50"])[z]
    ax.text(0.02,0.03,f"tertile split (cut {s['sep_bl']['33']:.1f} BL): "
            f"near {nq:.2f}x  far {fq:.2f}x",transform=ax.transAxes,
            color=MUTED,fontsize=6.5)
fig.savefig("figs/out/fig5_rear_coupling_review.png",dpi=150); print("ok")
