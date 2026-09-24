import html2canvas from "html2canvas";
import { jsPDF } from "jspdf";
import css from "./styles.css?inline";

let generatedUrl = "";
export function clearGeneratedPdf() {
  if (generatedUrl) URL.revokeObjectURL(generatedUrl);
  generatedUrl = "";
  document.getElementById("pdfOutput")?.replaceChildren();
}

// Pagination is part of the PDF, never delegated to Safari's webpage printer.
export async function createOrderPdf(receiptCard, sharing) {
  const frame = document.createElement("iframe");
  frame.title = "PDF作成用";
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;left:-10000px;top:0;width:794px;height:1123px;border:0;pointer-events:none";
  document.body.append(frame);
  try {
    const doc = frame.contentDocument;
    doc.open();
    doc.write('<!doctype html><html lang="ja"><head><meta charset="utf-8"></head><body><section id="receiptView"><div id="receiptCard"></div></section></body></html>');
    doc.close();
    const style = doc.createElement("style");
    style.textContent = css.replace(/@media print/g, "@media all").replace(/@media screen/g, "@media not all")
      .replace(/body\s*>\s*\*?:not\(#receiptView\)\s*\{[^}]*\}/g, "")
      + '\nhtml,body{width:794px!important} #receiptView{width:794px!important}';
    doc.head.append(style);
    doc.body.dataset.printCopy = sharing ? "sharing" : "both";
    const card = doc.getElementById("receiptCard");
    for (const node of receiptCard.querySelectorAll(".receiptCopy")) card.append(node.cloneNode(true));
    if (sharing) for (const node of receiptCard.querySelectorAll(".shareAttachmentPage")) card.append(node.cloneNode(true));
    await Promise.all([...card.querySelectorAll("img")].map(img => img.decode()));
    await doc.fonts.ready;
    const pdf = new jsPDF({ unit: "mm", format: "a4", compress: true });
    pdf.setProperties({ title: "注文書", creator: "SAN NISHIMURA" });
    let pages = 0;
    for (const node of card.children) {
      const attachment = node.classList.contains("shareAttachmentPage");
      const canvas = await html2canvas(node, { scale: 2, backgroundColor: "#ffffff", logging: false, windowWidth: 794, windowHeight: 1123, scrollX: 0, scrollY: 0, ignoreElements: el => attachment && el.tagName === "IMG" });
      if (!canvas.width || !canvas.height) {
        const r=node.getBoundingClientRect();
        throw new Error(`PDF画像を作成できませんでした（${canvas.width}x${canvas.height}, ${r.width}x${r.height}）。`);
      }
      if (attachment) {
        if (pages++) pdf.addPage();
        const scale = Math.min(194 / canvas.width, 277 / canvas.height);
        pdf.addImage(canvas.toDataURL("image/jpeg", 0.95), "JPEG", (210-canvas.width*scale)/2, 10, canvas.width*scale, canvas.height*scale);
        const photo=node.querySelector("img");
        const raster=doc.createElement("canvas");
        raster.width=photo.naturalWidth; raster.height=photo.naturalHeight;
        raster.getContext("2d").drawImage(photo,0,0);
        const fit=Math.min(194/raster.width,180/raster.height);
        pdf.addImage(raster.toDataURL("image/jpeg",0.95),"JPEG",(210-raster.width*fit)/2,34,raster.width*fit,raster.height*fit);
        raster.width=raster.height=1;
      } else {
        // Keep ordinary rows together when a long order needs extra pages.
        const bounds = node.getBoundingClientRect();
        const ratio = canvas.width / bounds.width;
        const breaks = [...node.querySelectorAll("tr,.receiptHeaderSimple,.receiptInfoBand,.receiptPickupNumber,.receiptFooterGrid,.receiptFooterMini")]
          .flatMap(el => { const r = el.getBoundingClientRect(); return [Math.floor((r.top-bounds.top)*ratio), Math.ceil((r.bottom-bounds.top)*ratio)]; });
        const capacity = Math.floor(canvas.width * 277 / 194);
        for (let top=0; top<canvas.height;) {
          let end = Math.min(canvas.height, top+capacity);
          if (end<canvas.height) {
            const safe = breaks.filter(y=>y>top+capacity/2 && y<=end);
            if (safe.length) end=Math.max(...safe);
          }
          const slice = doc.createElement("canvas");
          slice.width=canvas.width; slice.height=end-top;
          slice.getContext("2d").drawImage(canvas,0,top,canvas.width,end-top,0,0,canvas.width,end-top);
          if (pages++) pdf.addPage();
          pdf.addImage(slice.toDataURL("image/jpeg",0.95),"JPEG",8,10,194,slice.height*194/slice.width);
          slice.width=slice.height=1;
          top=end;
        }
      }
      canvas.width=canvas.height=1;
    }
    return { blob: pdf.output("blob"), pages };
  } finally { frame.remove(); }
}

export function offerOrderPdf({ blob, pages }, filename) {
  clearGeneratedPdf();
  generatedUrl=URL.createObjectURL(blob);
  const panel=document.getElementById("pdfOutput");
  const message=document.createElement("p");
  message.textContent=`PDFを作成しました（${pages}ページ）。PDFを開き、共有メニューから印刷できます。`;
  const open=document.createElement("a");
  open.href=generatedUrl; open.target="_blank"; open.rel="noopener";
  open.className="primary"; open.textContent="PDFを開く・印刷";
  const save=document.createElement("a");
  save.href=generatedUrl; save.download=filename; save.className="secondary"; save.textContent="PDFを保存";
  panel.append(message,open,save);
  const file=new File([blob],filename,{type:"application/pdf"});
  if (navigator.canShare?.({files:[file]})) {
    const share=document.createElement("button");
    share.type="button"; share.className="primary"; share.textContent="PDFを共有（Slackなど）";
    share.onclick=async()=>{
      try { await navigator.share({files:[file]}); }
      catch(error) { if(error.name!=="AbortError") message.textContent="共有できませんでした。「PDFを保存」から保存して投稿してください。"; }
    };
    panel.append(share);
  }
  panel.scrollIntoView({block:"center",behavior:"smooth"});
}
