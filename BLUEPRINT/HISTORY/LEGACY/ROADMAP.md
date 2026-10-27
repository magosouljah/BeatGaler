# BeatGaler V1 — Soft Roadmap

Este roadmap da dirección hacia V1 sin convertirse en un plan rígido ni duplicar GitHub.

Los escalones orientan el orden general. El estado real del trabajo vive en GitHub y runtime.

## Escalón actual

**1. Encontrar y usar**

Estamos terminando el núcleo que permite abrir BeatGaler, encontrar un beat y usarlo sin fricción.

## 1. Encontrar y usar

```text
abrir BeatGaler
→ ver la biblioteca
→ buscar / ordenar
→ escuchar
→ descargar
```

Objetivo: que este flujo sea rápido, correcto y confiable en las plataformas correspondientes.

## 2. Construir y organizar

```text
subir / importar
→ Review
→ metadata / artwork
→ organizar
→ editar
→ guardar
```

Objetivo: que preparar la biblioteca sea simple y que todo lo hecho aquí mejore directamente el flujo 1.

## 3. Biblioteca confiable

```text
sync
→ multi-device
→ offline
→ Trash / restore
→ recovery
→ fallos de red o Cloud
```

Objetivo: que los dos flujos centrales sobrevivan dispositivos, desconexiones y fallos sin perder ni corromper trabajo.

## 4. Completar V1

Cerrar las features restantes definidas en `V1.md` que no formen parte directa de los dos flujos centrales.

Incluye, cuando corresponda:

- YouTube;
- cuenta, sesiones y dispositivos;
- planes, límites, suscripciones y pagos;
- administración y superficies necesarias alrededor del producto.

## 5. Preparar para usuarios reales

Convertir el producto terminado en algo que podamos operar y distribuir con confianza.

Incluye lo que aplique de:

- seguridad final;
- deploy y recovery;
- Windows/macOS release chain;
- signing/notarization/updater;
- legal;
- soporte/status;
- observabilidad;
- capacidad y pruebas en hardware real.

## 6. Beta → RC → V1

```text
usuarios reales
→ encontrar problemas
→ corregir
→ repetir
→ RC
→ V1
```

Objetivo: validar el producto completo, corregir problemas reales y congelar una V1 confiable.

## Cómo se usa

No se detallan todos los escalones por adelantado.

En cada momento:

```text
escalón actual
→ elegir el problema más importante
→ resolverlo siguiendo SYSTEM.md
→ cerrar limpio
→ elegir el siguiente
```

Normalmente avanzamos dentro del escalón actual, pero no es una línea rígida: un problema de seguridad, integridad de datos o dependencia crítica puede adelantarse si bloquea o pone en riesgo V1.

Se cambia de escalón cuando el anterior ya no contiene el problema más importante que impide llegar a V1.
