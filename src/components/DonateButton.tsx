import Icono from "./Icono";
import { invoke } from "@tauri-apps/api/core";
import { PAYPAL_URL } from "../credits";

interface Props {
  compact?: boolean;
}

export default function DonateButton({ compact = false }: Props) {
  const abrir = () => {
    invoke("open_url", { url: PAYPAL_URL }).catch(() => {});
  };
  return (
    <button
      className="btn donate"
      onClick={abrir}
      title="Apoya el desarrollo con una donación"
    >
      <Icono n="heart" />{compact ? "" : " Donar"}
    </button>
  );
}
