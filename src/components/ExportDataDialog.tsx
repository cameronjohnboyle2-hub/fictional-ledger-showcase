import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { getTransactions, getCurrencyCodeLabel } from '@/lib/storage';
import { csvCell } from '@/showcase/csv';

export default function ExportDataDialog({ open, onOpenChange }: {open: boolean; onOpenChange: (open: boolean) => void}) {
  const download = () => {
    const rows = [['Date', 'Type', 'Amount', 'Currency', 'Note'], ...getTransactions().map(t => [t.date, t.type, t.amount, t.currency || getCurrencyCodeLabel(), t.note || ''])];
    const text = rows.map(row => row.map(csvCell).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob(['\uFEFF', text], {type: 'text/csv;charset=utf-8'}));
    const link = document.createElement('a'); link.href = url; link.download = 'fictional-ledger.csv'; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent><DialogHeader><DialogTitle>Export fictional transactions</DialogTitle></DialogHeader>
    <p>Downloads this demo's current in-memory ledger. No cloud export or real business records.</p>
    <Button onClick={download}>Download CSV</Button>
  </DialogContent></Dialog>;
}
